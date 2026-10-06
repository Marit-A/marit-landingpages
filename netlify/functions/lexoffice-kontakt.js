const https = require("https");

// Lexoffice-Kontakt nach einem Mollie-Kauf: erst abgleichen, nur wenn es den Kontakt
// noch nicht gibt, einen neuen anlegen. Es wird KEINE Rechnung erstellt.
//
// Abgleich (mindestens zwei von drei Kriterien müssen übereinstimmen):
//   1. E-Mail-Adresse (egal ob am Kontakt oder an einer Ansprechperson)
//   2. Name: Klarname oder Firma gegen Personenname, Firmenname, Ansprechpersonen
//      und die Zeile unter dem Namen (Adress-Zusatz), unscharf (Tippfehler, Titel,
//      Rechtsform, vertauschte Reihenfolge)
//   3. Postleitzahl (im selben Land)
//
// Ergebnis:
//   "vorhanden"  mindestens zwei Kriterien passen: nichts anlegen, Kontakt merken
//   "neu"        kein Kriterium passt (oder nur die PLZ): neuen Kontakt anlegen
//   "pruefen"    nur die E-Mail ODER nur der Name passt (Umzug, neue Mailadresse,
//                gleichnamige Person?), oder mehrere Kontakte passen gleich gut,
//                oder Pflichtangaben fehlen: nichts anlegen, Marit entscheidet
//
// Kontaktform: Klarname der Person als Kontaktname, der Firmenname in der Zeile
// darunter (Adress-Zusatz). Ausnahme: Firma im Ausland mit USt-IdNr., dann steht die
// Firma zuerst (Rechnung geht an das Unternehmen) und die Person ist Ansprechperson.
//
// Schalter in Netlify (Environment variables):
//   LEXOFFICE_API_KEY     fehlt: dieser Schritt wird übersprungen
//   LEXOFFICE_KONTAKTE    "an": Kontakte werden wirklich angelegt
//                         alles andere (oder nichts): Probelauf, es wird nur geprüft
//                         und in der Info-Mail gemeldet, was passieren würde

const SCHWELLE_NAME = 0.85;

// ── Normalisieren ─────────────────────────────────────────────────────────────

const TITEL = new Set(["dr", "prof", "mag", "dipl", "ing", "med", "rer", "nat", "phil", "mba", "msc", "bsc", "dr.", "herr", "frau"]);
const RECHTSFORMEN = new Set(["gmbh", "ug", "gbr", "ek", "kg", "ag", "mbh", "co", "ltd", "inc", "llc", "sarl", "sl", "bv", "ohg", "haftungsbeschrankt", "eu", "ev", "e", "k", "v"]);

function tokens(s, { ohneRechtsform = true } = {}) {
  const t = String(s || "")
    .replace(/ß/g, "ss").replace(/ä/gi, "ae").replace(/ö/gi, "oe").replace(/ü/gi, "ue")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " und ")
    .match(/[a-z0-9]+/g) || [];
  return t.filter(w => !TITEL.has(w) && !(ohneRechtsform && RECHTSFORMEN.has(w)));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Ähnlichkeit zweier einzelner Wörter. Kurze Wörter (unter 4 Buchstaben) müssen gleich sein,
// sonst wären Jan und Jana dieselbe Person. Meyer und Mayer (0,80) bleiben bewusst verschieden.
function wortAehnlichkeit(a, b) {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 4) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
const WORT_SCHWELLE = 0.85;

// Ähnlichkeit zweier Namen von 0 bis 1 (Treffer ab SCHWELLE_NAME). Reihenfolge der Wörter,
// Titel und Rechtsform spielen keine Rolle. Alle Wörter des kürzeren Namens müssen im längeren
// vorkommen, einzelne Wörter dürfen kleine Tippfehler haben:
//   "Sabrina Ploch" in "Mag. Ploch Sabrina", "Life is Change" in "Life is Change GmbH - Maria Kosmala",
//   "Tanja Hermann-Hurtzig" in "Tanja Herrmann-Hurtzig Karrierecoach"
// Ein einzelnes Wort passt nur zu einem einzelnen Wort (Firmenname "Cochachingzonen" gegen "Coachingzonen").
function nameAehnlichkeit(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const [klein, gross] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (klein.length === 1 && gross.length > 1) return 0;
  const frei = gross.slice();
  let summe = 0, gefunden = 0;
  for (const w of klein) {
    let beste = 0, besteI = -1;
    frei.forEach((g, i) => { const x = wortAehnlichkeit(w, g); if (x > beste) { beste = x; besteI = i; } });
    if (beste >= WORT_SCHWELLE) { summe += beste; gefunden++; frei.splice(besteI, 1); }
  }
  if (gefunden < klein.length) return (gefunden / klein.length) * 0.8 * (gefunden ? summe / gefunden : 0);
  const schnitt = summe / klein.length;
  return gross.length === klein.length ? schnitt : Math.max(0.9, schnitt - 0.02);
}

function zipNorm(z) {
  return String(z || "").replace(/\s+/g, "").toUpperCase();
}

function mailNorm(e) {
  return String(e || "").trim().toLowerCase();
}

// ── Kontakt lesen ─────────────────────────────────────────────────────────────

function kontaktAdressen(c) {
  const a = c.addresses || {};
  return [...(a.billing || []), ...(a.shipping || [])];
}

function kontaktMails(c) {
  const m = new Set();
  for (const liste of Object.values(c.emailAddresses || {})) for (const e of liste || []) m.add(mailNorm(e));
  for (const p of (c.company && c.company.contactPersons) || []) if (p.emailAddress) m.add(mailNorm(p.emailAddress));
  return m;
}

function kontaktNamen(c) {
  const n = [];
  const voll = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ");
  if (c.person) n.push(voll(c.person));
  if (c.company) {
    n.push(c.company.name);
    for (const p of c.company.contactPersons || []) n.push(voll(p));
  }
  for (const a of kontaktAdressen(c)) if (a.supplement) n.push(a.supplement);
  return n.filter(x => x && x.trim());
}

function kontaktAnzeige(c) {
  const person = c.person ? [c.person.firstName, c.person.lastName].filter(Boolean).join(" ") : "";
  const supp = (((c.addresses || {}).billing || [])[0] || {}).supplement;
  if (c.company) return c.company.name + (person ? " - " + person : "");
  return person + (supp ? " (" + supp + ")" : "");
}

// ── Abgleich ──────────────────────────────────────────────────────────────────

function kaeuferNamen(m) {
  const klar = [m.firstName, m.lastName].filter(s => s && String(s).trim()).join(" ").trim();
  return { klar, firma: String(m.company || "").trim() };
}

function pruefeKontakt(c, m) {
  const { klar, firma } = kaeuferNamen(m);
  const kriterien = [];
  const mail = mailNorm(m.email);
  if (mail && kontaktMails(c).has(mail)) kriterien.push("E-Mail");

  let beste = 0;
  for (const kn of kontaktNamen(c)) {
    for (const mn of [klar, firma]) {
      if (mn) beste = Math.max(beste, nameAehnlichkeit(mn, kn));
    }
  }
  if (beste >= SCHWELLE_NAME) kriterien.push("Name");

  const zip = zipNorm(m.zip);
  const land = String(m.country || "").toUpperCase();
  if (zip && kontaktAdressen(c).some(a => zipNorm(a.zip) === zip && (!a.countryCode || !land || String(a.countryCode).toUpperCase() === land))) {
    kriterien.push("PLZ");
  }
  return { kriterien, nameScore: beste };
}

function findeKontakt(kontakte, m) {
  const sicher = [];
  const einzeln = [];   // genau ein Kriterium, und das ist E-Mail oder Name
  for (const c of kontakte) {
    const { kriterien, nameScore } = pruefeKontakt(c, m);
    if (kriterien.length >= 2) sicher.push({ c, kriterien, nameScore });
    else if (kriterien.length === 1 && kriterien[0] !== "PLZ") einzeln.push({ c, kriterien, nameScore });
  }
  sicher.sort((a, b) => b.kriterien.length - a.kriterien.length || b.nameScore - a.nameScore);
  const hinweise = [];

  if (sicher.length === 1 || (sicher.length > 1 && (sicher[0].kriterien.length > sicher[1].kriterien.length || sicher[0].nameScore - sicher[1].nameScore > 0.1))) {
    const t = sicher[0];
    const extra = [];
    if (t.c.archived) extra.push("Kontakt ist archiviert");
    if (!(t.c.roles && t.c.roles.customer)) extra.push("Kontakt hat keine Kundenrolle (nur Lieferant?)");
    return { ergebnis: "vorhanden", kontakt: { id: t.c.id, name: kontaktAnzeige(t.c) }, kriterien: t.kriterien, hinweise: [...extra, ...hinweise] };
  }
  if (sicher.length > 1) {
    return {
      ergebnis: "pruefen",
      kontakt: null,
      kriterien: [],
      hinweise: [`Mehrere Kontakte passen gleich gut: ${sicher.map(t => '"' + kontaktAnzeige(t.c) + '"').join(", ")}`, ...hinweise]
    };
  }
  if (einzeln.length) {
    const andere = (k) => (k === "E-Mail" ? "Name und PLZ" : "E-Mail und PLZ");
    return {
      ergebnis: "pruefen",
      kontakt: null,
      kriterien: [...new Set(einzeln.flatMap(t => t.kriterien))],
      hinweise: einzeln.map(t => `Nur ${t.kriterien[0] === "E-Mail" ? "die E-Mail" : "der Name"} passt zu "${kontaktAnzeige(t.c)}" (${andere(t.kriterien[0])} weichen ab). Bitte entscheiden, ob es dieselbe Person ist`)
    };
  }
  return { ergebnis: "neu", kontakt: null, kriterien: [], hinweise };
}

// ── Neuen Kontakt bauen ───────────────────────────────────────────────────────

function sauber(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

// Liefert { kontakt } oder { fehler }
function baueKontakt(m, produktName, zahlungsId, heute) {
  const vorname = sauber(m.firstName), nachname = sauber(m.lastName), firma = sauber(m.company);
  const land = sauber(m.country).toUpperCase();
  if (!nachname) return { fehler: "Nachname fehlt" };
  if (!sauber(m.street) || !sauber(m.zip) || !sauber(m.city)) return { fehler: "Adresse unvollständig" };
  if (!/^[A-Z]{2}$/.test(land) || land === "XX") return { fehler: `Land "${m.country || ""}" ist nicht eindeutig, bitte Kontakt von Hand anlegen` };

  const vatId = sauber(m.vatId);
  const klar = [vorname, nachname].filter(Boolean).join(" ");
  const firmaGleichName = firma && tokens(firma, { ohneRechtsform: false }).sort().join(" ") === tokens(klar, { ohneRechtsform: false }).sort().join(" ");
  const firmaZuerst = !!(firma && !firmaGleichName && vatId && land !== "DE");

  const adresse = { street: sauber(m.street), zip: sauber(m.zip), city: sauber(m.city), countryCode: land };
  const notiz = [
    `Automatisch angelegt nach Mollie-Kauf am ${heute} (${produktName}, ${zahlungsId}).`,
    vatId && !firmaZuerst ? `USt-IdNr./UID: ${vatId}` : null
  ].filter(Boolean).join(" ");

  const kontakt = {
    version: 0,
    roles: { customer: {} },
    addresses: { billing: [adresse] },
    emailAddresses: { business: [mailNorm(m.email)] },
    note: notiz
  };

  if (firmaZuerst) {
    kontakt.company = {
      name: firma,
      vatRegistrationId: vatId,
      allowTaxFreeInvoices: m.reverseCharge === "true",
      contactPersons: [{ firstName: vorname || undefined, lastName: nachname, primary: true }]
    };
  } else {
    kontakt.person = { firstName: vorname || undefined, lastName: nachname };
    if (firma && !firmaGleichName) adresse.supplement = firma;
  }
  return { kontakt };
}

// ── Lexoffice-Aufrufe ─────────────────────────────────────────────────────────

function lexofficeAufruf(key, method, path, body, timeoutMs, httpsLib) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = (httpsLib || https).request({
      hostname: "api.lexoffice.io",
      path: `/v1${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { message: String(data).slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed || {} });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Zeitüberschreitung bei Lexoffice (${path})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const warte = (ms) => new Promise(r => setTimeout(r, ms));

// Lexoffice erlaubt etwa zwei Aufrufe pro Sekunde; bei 429 einmal kurz warten und wiederholen
async function mitWiederholung(fn) {
  let a = await fn();
  if (a.status === 429) { await warte(700); a = await fn(); }
  return a;
}

async function alleKontakte(key, optionen) {
  const out = [];
  for (let seite = 0; seite < 8; seite++) {
    const a = await mitWiederholung(() => lexofficeAufruf(key, "GET", `/contacts?page=${seite}&size=250`, null, optionen.timeoutMs, optionen.https));
    if (a.status !== 200) throw new Error(`Kontakte lesen: HTTP ${a.status} ${a.body.message || ""}`.trim());
    out.push(...(a.body.content || []));
    if (a.body.last !== false) return out;
    await warte(optionen.pauseMs);
  }
  throw new Error("Kontakte lesen: mehr als 8 Seiten, Abbruch");
}

// Hauptfunktion für den Webhook. Wirft nie, liefert immer ein Ergebnis mit "text" für die Info-Mail.
//   payment:  Mollie-Zahlung (metadata mit Kundendaten)
//   optionen: { key, anlegen: true/false, produktName, https (nur Tests), timeoutMs, pauseMs, heute }
async function kontaktAbgleichenUndAnlegen(payment, optionen) {
  const o = { timeoutMs: 5000, pauseMs: 600, ...optionen };
  const m = (payment && payment.metadata) || {};
  const heute = o.heute || new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
  try {
    if (!o.key) return { ergebnis: "uebersprungen", ok: true, text: "übersprungen (LEXOFFICE_API_KEY fehlt in Netlify)" };
    if (!mailNorm(m.email)) return { ergebnis: "pruefen", ok: false, text: "Keine E-Mail in der Zahlung, Kontakt bitte von Hand prüfen" };

    const kontakte = await alleKontakte(o.key, o);
    const f = findeKontakt(kontakte, m);
    const hinweis = f.hinweise.length ? ` Hinweis: ${f.hinweise.join("; ")}.` : "";

    if (f.ergebnis === "vorhanden") {
      return { ...f, ok: true, text: `Kontakt schon vorhanden: "${f.kontakt.name}" (passt bei ${f.kriterien.join(" und ")}). Nichts angelegt.${hinweis}` };
    }
    if (f.ergebnis === "pruefen") {
      return { ...f, ok: false, text: `Bitte prüfen, nichts angelegt. ${f.hinweise.join("; ")}.` };
    }

    const b = baueKontakt(m, o.produktName || payment.description || "Mollie-Kauf", payment.id || "", heute);
    if (b.fehler) return { ergebnis: "pruefen", ok: false, kriterien: [], hinweise: [b.fehler], text: `Bitte von Hand anlegen: ${b.fehler}.${hinweis}` };

    const wer = b.kontakt.company ? `${b.kontakt.company.name} (Ansprechperson ${[m.firstName, m.lastName].filter(Boolean).join(" ")})` : `${[m.firstName, m.lastName].filter(Boolean).join(" ")}${b.kontakt.addresses.billing[0].supplement ? ", darunter " + b.kontakt.addresses.billing[0].supplement : ""}`;
    if (!o.anlegen) {
      return { ergebnis: "neu", ok: true, angelegt: false, vorschau: b.kontakt, hinweise: f.hinweise, text: `PROBELAUF, nichts angelegt. Würde neuen Kontakt anlegen: ${wer}.${hinweis}` };
    }

    await warte(o.pauseMs);
    const a = await mitWiederholung(() => lexofficeAufruf(o.key, "POST", "/contacts", b.kontakt, o.timeoutMs, o.https));
    if (a.status === 200 || a.status === 201) {
      return { ergebnis: "neu", ok: true, angelegt: true, kontakt: { id: a.body.id, name: wer }, hinweise: f.hinweise, text: `Neuer Kontakt angelegt: ${wer}.${hinweis}` };
    }
    const grund = (a.body.message || (a.body.IssueList && JSON.stringify(a.body.IssueList)) || "").toString().slice(0, 300);
    return { ergebnis: "fehler", ok: false, text: `FEHLER beim Anlegen (HTTP ${a.status} ${grund}). Bitte von Hand anlegen: ${wer}.` };
  } catch (err) {
    return { ergebnis: "fehler", ok: false, text: `FEHLER: ${err.message}. Bitte Kontakt von Hand prüfen oder anlegen.` };
  }
}

module.exports = {
  nameAehnlichkeit, pruefeKontakt, findeKontakt, baueKontakt, kontaktAbgleichenUndAnlegen, kontaktAnzeige,
  SCHWELLE_NAME
};
