// Gemeinsamer Ablauf nach jedem Mollie-Kauf, für alle Produkte (Baukasten, DEEP DESIGN,
// Vibe-Coding, VIP-Letter, neue Produkte):
//   1. Lexoffice-Kontakt abgleichen, bei Bedarf anlegen (lexoffice-kontakt.js)
//   2. Ampel prüfen (ampel.js)
//   3. grün: Rechnungsentwurf in Lexoffice anlegen (lexoffice-rechnung.js), NIE festschreiben
//      oder versenden. Fehlt der Artikel, wird er angelegt.
//      gelb/rot: kein Entwurf, Marit legt die Rechnung selbst an
//   4. Ergebnis als Zeilen für die Info-Mail an Marit (der Webhook verschickt sie)
//
// Doppelschutz: pro Zahlung höchstens ein Entwurf. Der Stand steht in den Mollie-Metadaten
// der Zahlung unter "lexoffice" (Mollie erlaubt das Nachtragen auch bei bezahlten Zahlungen):
//   "res:<token>:<ms>"   reserviert, Entwurf wird gerade angelegt (oder Ausgang unklar)
//   "re:<id>:<nummer>"   Entwurf liegt in Lexoffice
//   "gelb:<grund>"       kein Entwurf, Rechnung von Hand
// Vor dem Anlegen wird reserviert und nachgelesen. Steht danach etwas anderes drin, hat ein
// zweiter Aufruf gewonnen und dieser hier legt nichts an. Das Mollie-Cockpit und die
// Abrechnungs-Routine lesen dasselbe Feld.
//
// Schalter in Netlify (Environment variables):
//   LEXOFFICE_API_KEY        fehlt: ganzer Schritt aus (wie bisher)
//   LEXOFFICE_KONTAKTE=an    Kontakte wirklich anlegen (sonst Probelauf)
//   LEXOFFICE_ENTWUERFE=an   Entwürfe wirklich anlegen (sonst Probelauf: die Mail sagt, was passieren würde)
//   LEXOFFICE_STEUERFREI=an  auch steuerfreie Entwürfe (Reverse Charge, Drittland), erst nach dem Test mit Probekontakt

const https = require("https");
const crypto = require("crypto");
const { kontaktAbgleichenUndAnlegen } = require("./lexoffice-kontakt.js");
const { pruefeAmpel } = require("./ampel.js");
const { lexofficeAufruf, baueRechnung, artikelSicherstellen, vorlageFuer } = require("./lexoffice-rechnung.js");
const { vorlagen } = require("./rechnungsvorlagen.json");

const KONTAKT_FRIST_MS = 5500;      // Kontaktabgleich höchstens so lange
const ENTWURF_STARTET_BIS_MS = 6000; // später als so lange nach Webhook-Start wird kein Entwurf mehr begonnen
const NUMMER_HOLEN_BIS_MS = 7500;    // danach steht in der Mail nur der Link, die Nummer sieht Marit in Lexoffice
const LINK = (id) => `https://app.lexoffice.de/permalink/invoices/edit/${id}`;
const euro = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";

function schalter() {
  const an = (n) => String(process.env[n] || "").toLowerCase() === "an";
  return {
    key: process.env.LEXOFFICE_API_KEY,
    kontakteAnlegen: an("LEXOFFICE_KONTAKTE"),
    entwuerfe: an("LEXOFFICE_ENTWUERFE"),
    steuerfrei: an("LEXOFFICE_STEUERFREI")
  };
}

// ── Mollie: Metadaten der Zahlung lesen und ergänzen ───────────────────────────

function mollieAufruf(key, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.mollie.com",
      path: `/v2${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = {}; }
        resolve({ status: res.statusCode, body: parsed || {} });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 3000, () => req.destroy(new Error(`Zeitüberschreitung bei Mollie (${path})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// Setzt metadata.lexoffice, alle anderen Metadaten bleiben erhalten. Liefert true/false.
async function markeSetzen(mollieKey, payment, wert) {
  try {
    const metadata = { ...(payment.metadata || {}), lexoffice: String(wert).slice(0, 180) };
    const a = await mollieAufruf(mollieKey, "PATCH", `/payments/${payment.id}`, { metadata });
    if (a.status === 200) { payment.metadata = metadata; return true; }
    console.error(`Mollie-Marke setzen: HTTP ${a.status}`);
    return false;
  } catch (err) {
    console.error("Mollie-Marke setzen:", err.message);
    return false;
  }
}

async function markeLesen(mollieKey, paymentId) {
  const a = await mollieAufruf(mollieKey, "GET", `/payments/${paymentId}`);
  if (a.status !== 200) throw new Error(`Mollie lesen: HTTP ${a.status}`);
  return (a.body.metadata || {}).lexoffice || "";
}

// "re:<id>:<nummer>" -> { id, nummer }
function markeDeuten(wert) {
  const w = String(wert || "");
  if (w.startsWith("re:")) { const [, id, nummer] = w.split(":"); return { art: "entwurf", id, nummer: nummer || "" }; }
  if (w.startsWith("res:")) { const [, , ms] = w.split(":"); return { art: "reserviert", seit: Number(ms) || 0 }; }
  if (w.startsWith("gelb:")) return { art: "gelb", grund: w.slice(5) };
  return { art: w ? "unbekannt" : "leer" };
}

// ── Preise für die Ampel ───────────────────────────────────────────────────────

// Baukasten-Produkt (Eintrag aus baukasten-produkte.json) oder alte Vorlage mit preise/rabattcodes
function preiseFuer(baukastenProdukt, vorlage) {
  if (baukastenProdukt) {
    const codes = {};
    for (const [c, r] of Object.entries(baukastenProdukt.rabattcodes || {})) codes[c.toUpperCase()] = { abzug: r.abzug_netto_cent || 0 };
    return { listen: [baukastenProdukt.netto_cent], codes };
  }
  const codes = {};
  for (const [c, n] of Object.entries((vorlage && vorlage.rabattcodes) || {})) codes[c.toUpperCase()] = { endpreis: n };
  return { listen: (vorlage && vorlage.preise) || [], codes };
}

// ── Hauptablauf ────────────────────────────────────────────────────────────────

async function mitFrist(versprechen, ms, ersatz) {
  let timer;
  const frist = new Promise(resolve => { timer = setTimeout(() => resolve(ersatz), ms); });
  try { return await Promise.race([versprechen, frist]); } finally { clearTimeout(timer); }
}

// Wirft nie. Liefert { kontakt, ampel, entwurf, rechnungZeilen, betreffZusatz }.
//   payment:   Mollie-Zahlung (frisch gelesen, status paid)
//   kennung:   Schlüssel in rechnungsvorlagen.json (metadata.product, beim VIP-Letter "vip_letter")
//   produktName, baukastenProdukt (optional), mollieKey, start (Date.now() beim Webhook-Start)
async function kaufAblauf({ payment, kennung, produktName, baukastenProdukt, mollieKey, start, einstellungen }) {
  const s = { ...schalter(), ...(einstellungen || {}) };
  const beginn = start || Date.now();
  const ergebnis = { kontakt: null, ampel: null, entwurf: { status: "aus" }, rechnungZeilen: [], betreffZusatz: "" };
  try {
    ergebnis.kontakt = await mitFrist(
      kontaktAbgleichenUndAnlegen(payment, { key: s.key, anlegen: s.kontakteAnlegen, produktName }),
      KONTAKT_FRIST_MS,
      { ergebnis: "fehler", ok: false, text: "FEHLER: Lexoffice hat nicht rechtzeitig geantwortet. Bitte Kontakt von Hand prüfen oder anlegen." }
    );
    if (!s.key) return ergebnis;  // ohne Lexoffice-Schlüssel wie bisher: keine Rechnungszeilen

    const vorlage = vorlagen[kennung] || null;
    const ampel = pruefeAmpel({ payment, vorlage, preise: preiseFuer(baukastenProdukt, vorlage), kontakt: ergebnis.kontakt, steuerfreiErlaubt: s.steuerfrei });
    ergebnis.ampel = ampel;
    const marke = markeDeuten((payment.metadata || {}).lexoffice);

    if (marke.art === "entwurf") {
      ergebnis.entwurf = { status: "vorhanden", id: marke.id, nummer: marke.nummer };
    } else if (marke.art === "reserviert") {
      ergebnis.entwurf = { status: "unklar", text: "Ein anderer Durchlauf legt den Entwurf gerade an oder hat abgebrochen" };
    } else if (ampel.farbe !== "gruen") {
      ergebnis.entwurf = { status: "keiner" };
      if (s.entwuerfe && mollieKey && marke.art !== "gelb") await markeSetzen(mollieKey, payment, `gelb:${ampel.gruende[0] || ""}`);
    } else if (!s.entwuerfe) {
      const art = await artikelSicherstellen(s.key, vorlage, (payment.metadata || {}).discountCode, ampel.nettoCent, { anlegen: false }).catch(e => ({ fehler: e.message }));
      ergebnis.entwurf = { status: "probelauf", artikel: art };
    } else if (Date.now() - beginn > ENTWURF_STARTET_BIS_MS) {
      ergebnis.entwurf = { status: "zeit" };
    } else {
      ergebnis.entwurf = await entwurfAnlegen({ payment, vorlage, ampel, kontakt: ergebnis.kontakt, mollieKey, key: s.key, beginn });
    }
  } catch (err) {
    console.error("Kaufablauf Fehler:", err.message);
    ergebnis.entwurf = { status: "fehler", text: err.message };
  }
  Object.assign(ergebnis, mailTexte(ergebnis, payment, kennung));
  return ergebnis;
}

async function entwurfAnlegen({ payment, vorlage, ampel, kontakt, mollieKey, key, beginn }) {
  if (!mollieKey) return { status: "fehler", text: "Kein Mollie-Schlüssel für den Doppelschutz" };
  const m = payment.metadata || {};

  const art = await artikelSicherstellen(key, vorlage, m.discountCode, ampel.nettoCent);
  if (art.fehler) return { status: "fehler", text: art.fehler };

  // Doppelschutz: reservieren, nachlesen, erst dann anlegen
  const token = crypto.randomBytes(4).toString("hex");
  const reserviert = `res:${token}:${Date.now()}`;
  if (!(await markeSetzen(mollieKey, payment, reserviert))) return { status: "fehler", text: "Doppelschutz in Mollie ließ sich nicht setzen, deshalb kein Entwurf" };
  const jetzt = await markeLesen(mollieKey, payment.id).catch(() => null);
  if (jetzt !== reserviert) {
    const d = markeDeuten(jetzt);
    return d.art === "entwurf" ? { status: "vorhanden", id: d.id, nummer: d.nummer } : { status: "unklar", text: "Ein zweiter Durchlauf war schneller" };
  }

  const rechnung = baueRechnung({ payment, vorlage, artikelId: art.id, kontakt: kontakt.kontakt.roh, ampel });
  let antwort;
  try {
    antwort = await lexofficeAufruf(key, "POST", "/invoices", rechnung, 4000);
  } catch (err) {
    // Ausgang unbekannt: Reservierung bleibt stehen, damit nichts doppelt entsteht
    return { status: "unklar", text: err.message };
  }
  if (antwort.status !== 200 && antwort.status !== 201) {
    const grund = String(antwort.body.message || (antwort.body.IssueList && JSON.stringify(antwort.body.IssueList)) || "").slice(0, 200);
    await markeSetzen(mollieKey, payment, `gelb:Lexoffice lehnt den Entwurf ab (HTTP ${antwort.status})`);
    return { status: "fehler", text: `Lexoffice lehnt den Entwurf ab (HTTP ${antwort.status} ${grund})`.trim() };
  }
  const id = antwort.body.id;
  let nummer = "";
  if (Date.now() - (beginn || 0) < NUMMER_HOLEN_BIS_MS) {
    try {
      const r = await lexofficeAufruf(key, "GET", `/invoices/${id}`, null, 1500);
      nummer = (r.body && r.body.voucherNumber) || "";
    } catch (err) { /* Nummer steht dann nur in Lexoffice */ }
  }
  await markeSetzen(mollieKey, payment, `re:${id}:${nummer}`);
  return { status: "angelegt", id, nummer, artikelNeu: art.neu ? art.text : "" };
}

// ── Texte für die Info-Mail ────────────────────────────────────────────────────

function mailTexte(e, payment, kennung) {
  const a = e.ampel;
  const z = [];
  let betreff = "";
  if (!a) return { rechnungZeilen: z, betreffZusatz: betreff };
  const v = vorlageFuer(vorlagen[kennung] || {}, (payment.metadata || {}).discountCode);
  const steuer = a.satz === 0 ? "ohne deutsche USt" : "19 % USt";
  const was = `${v.position || "Position"}, ${a.nettoCent !== null ? euro(a.nettoCent) + " netto" : "Betrag unklar"}, ${steuer}`;
  const gruende = a.gruende.length ? a.gruende.join("; ") : "";
  const en = e.entwurf;

  if (en.status === "angelegt") {
    z.push(`Rechnung: 🟢 Entwurf ${en.nummer || ""} liegt in Lexoffice bereit (${was}). Bitte ansehen, festschreiben und versenden: ${LINK(en.id)}`.replace("  ", " "));
    if (en.artikelNeu) z.push(`Hinweis: ${en.artikelNeu}.`);
    betreff = " · 🟢";
  } else if (en.status === "vorhanden") {
    z.push(`Rechnung: Für diese Zahlung gibt es schon den Entwurf ${en.nummer || en.id}, es wurde kein zweiter angelegt. ${LINK(en.id)}`);
    betreff = " · 🟢";
  } else if (en.status === "probelauf") {
    const artikel = en.artikel && en.artikel.text ? ` ${en.artikel.text}.` : "";
    z.push(a.farbe === "gruen"
      ? `Rechnung (PROBELAUF, nichts angelegt): 🟢 Ampel grün. Würde Entwurf anlegen: ${was}.${artikel}`
      : `Rechnung (PROBELAUF, nichts angelegt): 🟡 Ampel ${a.farbe}, würde keinen Entwurf anlegen. Grund: ${gruende}.`);
    betreff = ` · Rechnung Probelauf ${a.farbe === "gruen" ? "🟢" : "🟡"}`;
  } else if (en.status === "unklar") {
    z.push(`⚠️ Rechnung: Unklar, ob ein Entwurf angelegt wurde (${en.text || "keine Antwort"}). Bitte erst in Lexoffice nachsehen, bevor du eine Rechnung anlegst.`);
    betreff = " · ⚠️ Rechnung unklar";
  } else {
    const warum = en.status === "zeit" ? "Lexoffice war zu langsam, der Entwurf wurde nicht mehr begonnen"
      : en.status === "fehler" ? en.text
      : gruende;
    z.push(`Rechnung: ${a.farbe === "rot" ? "🔴" : "🟡"} kein Entwurf, bitte von Hand anlegen. Grund: ${warum}.`);
    if (a.vermerk) z.push(`Steuer: ${a.vermerk}.`);
    if (a.nettoCent !== null) z.push(`Position: ${was}.`);
    betreff = ` · ${a.farbe === "rot" ? "🔴" : "🟡"} Rechnung von Hand`;
  }
  return { rechnungZeilen: z, betreffZusatz: betreff };
}

module.exports = { kaufAblauf, preiseFuer, markeDeuten, schalter };
