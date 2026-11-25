// Rechnungsentwurf in Lexoffice nach einem Mollie-Kauf (aufgerufen von kauf-ablauf.js).
// Baut die Rechnung nach der bewährten Form aus dem Skill mollie-lexoffice-abrechnung
// (Vorbilder: MA000459, MA000469, MA000471, MA000473) und legt sie NUR ALS ENTWURF an.
// Nie festschreiben (kein finalize), nie versenden. Rechnungen lassen sich per API weder
// ändern noch löschen, deshalb entsteht pro Zahlung höchstens ein Entwurf (Doppelschutz in
// kauf-ablauf.js).

const https = require("https");

function lexofficeAufruf(key, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
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
    req.setTimeout(timeoutMs || 4000, () => req.destroy(new Error(`Zeitüberschreitung bei Lexoffice (${path})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// "2026-12-04" -> "2026-12-04T00:00:00.000+01:00" (Zeitzone Europe/Berlin, Sommer- und Winterzeit)
function berlinIso(tag) {
  const mittag = new Date(`${tag}T12:00:00Z`);
  const teile = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", timeZoneName: "shortOffset" }).formatToParts(mittag);
  const off = (teile.find(t => t.type === "timeZoneName") || {}).value || "GMT+1";
  const mt = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const zone = mt ? `${mt[1]}${mt[2].padStart(2, "0")}:${mt[3] || "00"}` : "+01:00";
  return `${tag}T00:00:00.000${zone}`;
}

// ISO-Zeitpunkt -> "JJJJ-MM-TT" in Berlin
function berlinTag(iso) {
  return new Date(iso || Date.now()).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

function deutschesDatum(tag) {
  const [j, mo, t] = tag.split("-");
  return `${t}.${mo}.${j}`;
}

function sauber(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// "erika muster" -> "Erika Muster", gemischte Schreibweise bleibt, wie sie ist
function grossSchreiben(name) {
  const n = sauber(name);
  if (n !== n.toLowerCase() && n !== n.toUpperCase()) return n;
  return n.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

// Vorlage plus Variante für den Rabattcode (z. B. Powerwoche-Aufstockung)
function vorlageFuer(vorlage, code) {
  const v = vorlage || {};
  const c = String(code || "").trim().toUpperCase();
  const variante = (v.varianten || {})[c];
  return variante ? { ...v, ...variante } : v;
}

function versand(leistung, payment) {
  if (leistung && typeof leistung === "object" && leistung.von) {
    return { shippingType: "serviceperiod", shippingDate: berlinIso(leistung.von), shippingEndDate: berlinIso(leistung.bis || leistung.von) };
  }
  if (leistung === "zahlungstag") return { shippingType: "delivery", shippingDate: berlinIso(berlinTag(payment.paidAt)) };
  return { shippingType: "none" };
}

// Baut den Rechnungsentwurf. kontakt = Lexoffice-Kontakt (roh, mit id), ampel = Ergebnis aus ampel.js
function baueRechnung({ payment, vorlage, artikelId, kontakt, ampel, heute }) {
  const m = payment.metadata || {};
  const v = vorlageFuer(vorlage, m.discountCode);
  const klar = grossSchreiben([m.firstName, m.lastName].filter(Boolean).join(" "));
  const firma = sauber(m.company);
  const istFirma = !!(kontakt && kontakt.company);
  const name = istFirma ? sauber(kontakt.company.name) : klar;
  const zusatz = istFirma ? (klar !== name ? klar : "") : (firma && firma.toLowerCase() !== klar.toLowerCase() ? firma : "");
  const vorname = grossSchreiben(m.firstName) || klar;
  const zahltag = deutschesDatum(berlinTag(payment.paidAt));

  return {
    voucherDate: berlinIso(heute || berlinTag()),
    language: "de",
    title: v.titel || "Rechnung",
    address: {
      contactId: kontakt.id,
      name,
      ...(zusatz ? { supplement: zusatz } : {}),
      street: sauber(m.street),
      zip: sauber(m.zip),
      city: sauber(m.city),
      countryCode: /^[A-Z]{2}$/.test(String(m.country || "").toUpperCase()) ? String(m.country).toUpperCase() : ampel.steuer.land
    },
    lineItems: [{
      type: "material",
      id: artikelId,
      name: v.position || v.artikel_titel,
      ...(v.beschreibung ? { description: v.beschreibung } : {}),
      quantity: 1,
      unitName: "-",
      unitPrice: { currency: "EUR", netAmount: ampel.nettoCent / 100, taxRatePercentage: ampel.satz },
      discountPercentage: 0
    }],
    totalPrice: { currency: "EUR" },
    taxConditions: { taxType: ampel.taxType },
    paymentConditions: {
      paymentTermLabel: `\nDer Betrag wurde am ${zahltag} über Mollie Payments beglichen, vielen Dank.`,
      paymentTermDuration: 0
    },
    shippingConditions: versand(v.leistung, payment),
    introduction: String(v.einleitung || "\nLiebe {vorname},\n\ndanke für deinen Kauf! \nHier kommt deine Rechnung:").replace(/\{vorname\}/g, vorname),
    remark: v.schluss || "Herzliche Grüße\nMarit Alke"
  };
}

// Liefert die Artikel-ID: aus der Vorlage, sonst über den Titel gesucht, sonst neu angelegt.
// Ergebnis { id, neu, text } oder { fehler }
async function artikelSicherstellen(key, vorlage, code, listenNettoCent, optionen) {
  const o = { timeoutMs: 3000, anlegen: true, ...optionen };
  const v = vorlageFuer(vorlage, code);
  if (v.artikel_id) return { id: v.artikel_id, neu: false };
  const titel = sauber(v.artikel_titel || v.position);
  if (!titel) return { fehler: "In der Rechnungsvorlage fehlt artikel_titel" };
  const liste = await lexofficeAufruf(key, "GET", "/articles?page=0&size=250", null, o.timeoutMs);
  if (liste.status !== 200) return { fehler: `Artikel lesen: HTTP ${liste.status}` };
  const treffer = (liste.body.content || []).find(a => !a.archived && sauber(a.title).toLowerCase() === titel.toLowerCase());
  if (treffer) return { id: treffer.id, neu: false };
  if (!o.anlegen) return { id: null, neu: true, text: `Artikel „${titel}“ würde in Lexoffice angelegt` };
  const a = await lexofficeAufruf(key, "POST", "/articles", {
    title: titel, type: "PRODUCT", unitName: "-",
    price: { netPrice: (listenNettoCent || 0) / 100, leadingPrice: "NET", taxRate: 19 }
  }, o.timeoutMs);
  if (a.status === 200 || a.status === 201) return { id: a.body.id, neu: true, text: `Artikel „${titel}“ in Lexoffice neu angelegt` };
  return { fehler: `Artikel anlegen: HTTP ${a.status} ${String(a.body.message || "").slice(0, 120)}`.trim() };
}

module.exports = { lexofficeAufruf, baueRechnung, artikelSicherstellen, vorlageFuer, berlinIso, berlinTag, grossSchreiben };
