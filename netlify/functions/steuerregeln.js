// Steuerregeln für den Mollie-Baukasten (Stand 27.10.2026).
// Entscheidung und Quellen: Projekt "CCDD Webinar Powerwoche 4. Qtl. 2026",
// Dokument "umsatzsteuer-sonderfaelle-entscheidung.md".
//
// Der Block zwischen STEUERREGELN-START und STEUERREGELN-END steht WORTGLEICH
// auch in den Checkout-Formularen (Browser-Vorschau). Mollie/tests/test-steuerregeln.js
// prüft, dass alle Kopien identisch sind. Änderungen immer an allen Stellen machen.
//
// Regeln nach Leistungsart x Land x USt-IdNr.:
//   leistungsart "elektronisch" (reiner Selbstlernkurs):
//     DE                      -> 19 % deutsche USt
//     EU mit gültiger USt-ID  -> Reverse Charge, netto
//     EU ohne USt-ID          -> 19 % deutsche USt, nur mit Bestätigungs-Häkchen
//     Drittland (CH, GB, ...) -> netto (Leistungsort Ausland)
//   leistungsart "live" (enthält Live-Unterricht, z. B. Powerwoche):
//     DE                      -> 19 % deutsche USt
//     EU mit gültiger USt-ID  -> Reverse Charge, netto
//     EU ohne USt-ID          -> STOPP
//     Drittland               -> STOPP
// Ohne leistungsart im Produkt gilt weiter die alte Logik (andere Baukasten-Produkte).

/* STEUERREGELN-START */
function steuerRegel(leistungsart, country, vatId) {
  var EU = ["AT","BE","BG","CY","CZ","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"];
  var v = String(vatId || "").toUpperCase().replace(/[\s.\-]/g, "");
  var ort = String(country || "DE").toUpperCase();
  if (v.length >= 2) { ort = v.slice(0, 2); }
  if (ort === "EL") { ort = "GR"; }
  var mitUid = v.length >= 2;
  var live = leistungsart === "live";
  if (ort === "DE") {
    return { ort: ort, gruppe: "DE", mitUid: mitUid, aktion: "weiter", ust: "19", pruefeVies: false, braucht19Haken: false, grund: "" };
  }
  if (EU.indexOf(ort) !== -1) {
    if (mitUid) {
      return { ort: ort, gruppe: "EU", mitUid: true, aktion: "weiter", ust: "rc", pruefeVies: true, braucht19Haken: false, grund: "" };
    }
    if (live) {
      return { ort: ort, gruppe: "EU", mitUid: false, aktion: "stopp", ust: "", pruefeVies: false, braucht19Haken: false, grund: "eu_ohne_uid" };
    }
    return { ort: ort, gruppe: "EU", mitUid: false, aktion: "weiter", ust: "19", pruefeVies: false, braucht19Haken: true, grund: "" };
  }
  if (live) {
    return { ort: ort, gruppe: "DRITT", mitUid: mitUid, aktion: "stopp", ust: "", pruefeVies: false, braucht19Haken: false, grund: "drittland_live" };
  }
  return { ort: ort, gruppe: "DRITT", mitUid: mitUid, aktion: "weiter", ust: "netto", pruefeVies: false, braucht19Haken: false, grund: "" };
}

function plzPlausibel(country, zip) {
  var z = String(zip || "").replace(/\s/g, "");
  var c = String(country || "").toUpperCase();
  if (c === "DE") { return /^\d{5}$/.test(z); }
  if (c === "AT" || c === "CH") { return /^\d{4}$/.test(z); }
  return true;
}
/* STEUERREGELN-END */

const GRUENDE = {
  eu_ohne_uid: "Dieses Angebot enthält Live-Unterricht. Für Käufe aus dem EU-Ausland ohne USt-IdNr. kann ich die Umsatzsteuer über dieses Formular nicht korrekt abrechnen.",
  drittland_live: "Dieses Angebot enthält Live-Unterricht. Über dieses Formular kann ich es nur für Käufe aus Deutschland und für Unternehmen mit gültiger USt-IdNr. aus der EU abrechnen."
};

// HTML für den Stopp-Hinweis. stopp_modus "link" (Standard) zeigt den direkten CopeCart-Link,
// "mail" bittet um eine Mail. Fehlt der Link, wird automatisch der Mail-Text genommen.
function stoppMeldung(grund, produkt) {
  const text = GRUENDE[grund] || GRUENDE.drittland_live;
  const url = produkt && produkt.copecart_url;
  const modus = (produkt && produkt.stopp_modus) || "link";
  if (modus === "link" && url) {
    return `<p>${text}</p><p>Du kannst das Angebot stattdessen bei meinem Vertriebspartner CopeCart buchen, dort wird die Umsatzsteuer für dein Land abgerechnet: <a href="${url}">Zur Buchung bei CopeCart</a></p>`;
  }
  return `<p>${text}</p><p>Bitte schreib mir kurz an <a href="mailto:info@marit-alke.de">info@marit-alke.de</a>, dann finden wir den passenden Weg.</p>`;
}

// Kurzcode für die Mollie-Metadaten (1 kB-Grenze), z. B. "EU-RC", "EU-19-bestaetigt", "DRITT-netto"
function steuerfallCode(regel, bestaetigt19) {
  if (regel.gruppe === "DE") return "DE-19";
  if (regel.gruppe === "EU") return regel.ust === "rc" ? "EU-RC" : (bestaetigt19 ? "EU-19-bestaetigt" : "EU-19");
  return "DRITT-netto";
}

// Klartext für die Info-Mail und Lexoffice
function beschreibeSteuerfall(code, land) {
  switch (code) {
    case "DE-19": return "Deutsche USt 19 % (Käufer:in aus Deutschland)";
    case "EU-RC": return `Reverse Charge, Nettorechnung (EU-Unternehmen mit geprüfter USt-IdNr., ${land || "EU"}). Lexoffice: nicht steuerbar, Leistungsort EU-Ausland, in die ZM`;
    case "EU-19-bestaetigt": return `19 % deutsche USt, Käufer:in aus ${land || "EU"} ohne USt-IdNr. hat das Häkchen "Ich bin Privatperson/ohne USt-IdNr., 19 % sind mir bekannt" gesetzt. Keine nachträgliche Erstattung`;
    case "EU-19": return `19 % deutsche USt, Käufer:in aus ${land || "EU"} ohne USt-IdNr.`;
    case "DRITT-netto": return `Nettorechnung, Käufer:in aus Drittland (${land || "?"}). Lexoffice: nicht steuerbar, Leistungsort Ausland (UStVA Kennzahl 45)`;
    default: return "";
  }
}

// Land der Zahlung aus Mollie (Karte: cardCountryCode, SEPA-Überweisung: IBAN-Anfang)
function zahlungsland(payment) {
  const d = (payment && payment.details) || {};
  if (d.cardCountryCode) return String(d.cardCountryCode).toUpperCase();
  const iban = d.consumerAccount || d.bankAccount;
  if (iban && /^[A-Za-z]{2}\d{2}/.test(String(iban))) return String(iban).slice(0, 2).toUpperCase();
  return "";
}

// Gibt "" zurück, wenn alles passt oder das Land unbekannt ist, sonst einen Warntext
function landAbgleich(angegeben, zahlland) {
  if (!zahlland) return "";
  const a = String(angegeben || "").toUpperCase() === "EL" ? "GR" : String(angegeben || "").toUpperCase();
  if (a === zahlland) return "";
  return `Angegebenes Land ${a || "?"} weicht vom Land der Zahlung ${zahlland} ab (Kunden-Hinweis prüfen)`;
}


// ── Steuerfall für die Rechnung (kauf-ablauf.js) ─────────────────────────────
// Leitet aus den Metadaten einer Zahlung ab, wie die Rechnung aussehen muss. Gilt für alle
// Produkte, auch für die alten Checkouts ohne "steuerfall" (DEEP DESIGN, Vibe-Coding, VIP-Letter).
//   code:   DE-19, EU-19, EU-RC, DRITT-netto, DRITT-19
//   netto:  true = gezahlter Betrag ist netto (keine deutsche USt)
//   unklar: Grund, warum die Rechnung nicht automatisch entstehen darf (sonst "")
const EU_LAENDER = ["AT","BE","BG","CY","CZ","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"];

function steuerfallErmitteln(m, optionen) {
  const o = optionen || {};
  const vat = String(m.vatId || "").toUpperCase().replace(/[\s.\-]/g, "");
  let land = String(m.country || "DE").toUpperCase();
  if (vat.length >= 2 && /^[A-Z]{2}/.test(vat)) land = vat.slice(0, 2);
  if (land === "EL") land = "GR";
  const rc = m.reverseCharge === "true" || (m.reverseCharge === undefined && !!vat && String(m.country || "").toUpperCase() !== "DE");
  if (o.volleUst || land === "DE") return { code: "DE-19", land, netto: false, unklar: "" };
  if (EU_LAENDER.includes(land)) {
    if (!rc) return { code: "EU-19", land, netto: false, unklar: "" };
    if (m.vatValidated === "true") return { code: "EU-RC", land, netto: true, unklar: "" };
    return { code: "EU-RC", land, netto: true, unklar: "USt-IdNr. aus der EU ist nicht über VIES bestätigt" };
  }
  if (rc) return { code: "DRITT-netto", land, netto: true, unklar: "" };
  return { code: "DRITT-19", land, netto: false, unklar: `Käufer:in aus Drittland (${land}) hat 19 % deutsche USt gezahlt, Steuerfall bitte prüfen` };
}

module.exports = { steuerfallErmitteln, steuerRegel, plzPlausibel, stoppMeldung, steuerfallCode, beschreibeSteuerfall, zahlungsland, landAbgleich };
