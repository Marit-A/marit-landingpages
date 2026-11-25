// Ampel für den Rechnungsentwurf nach einem Mollie-Kauf (aufgerufen von kauf-ablauf.js).
// Reine Prüffunktion ohne Netzwerk: entscheidet, ob ein Entwurf in Lexoffice automatisch
// entstehen darf (grün) oder Marit die Rechnung selbst anlegt (gelb, rot).
//
//   grün: Kontakt eindeutig, Adresse und USt-IdNr. passen zum Kontakt, Steuerfall klar,
//         Betrag passt zum Preis bzw. zum Rabattcode
//   gelb: etwas ist unklar (Kontakt prüfen, andere Adresse, USt-IdNr., Betrag, steuerfreie
//         Rechnung noch nicht freigeschaltet), Rechnung von Hand
//   rot:  Erstattung oder ungewöhnliche Zahlung, erst klären
//
// Wird nie geworfen, liefert immer { farbe, gruende, steuer, nettoCent, taxType, vermerk }.

const { steuerfallErmitteln, zahlungsland, landAbgleich } = require("./steuerregeln.js");

const cent = (wert) => Math.round(parseFloat(wert || "0") * 100);
const brutto = (nettoCent) => Math.round(nettoCent * 1.19);
const zipNorm = (z) => String(z || "").replace(/\s+/g, "").toUpperCase();
const vatNorm = (v) => String(v || "").toUpperCase().replace(/[\s.\-]/g, "");
const euro = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";

// Erlaubte Nettopreise (in Cent) für den angegebenen Code. Liefert { liste } oder { fehler }.
//   preise.listen:     Nettopreise ohne Code (mehrere bei Preisstufen)
//   preise.codes:      Code -> { abzug } (Baukasten) oder Code -> { endpreis } (alte Checkouts)
function erwartetePreise(preise, code) {
  const listen = (preise && preise.listen) || [];
  const codes = (preise && preise.codes) || {};
  const c = String(code || "").trim().toUpperCase();
  if (!c) return { liste: listen };
  const eintrag = codes[c];
  if (!eintrag) return { fehler: `Rabattcode ${c} ist für dieses Produkt nicht bekannt` };
  if (eintrag.endpreis !== undefined) return { liste: [eintrag.endpreis] };
  return { liste: listen.map(n => Math.max(0, n - (eintrag.abzug || 0))) };
}

// Steuerbehandlung in Lexoffice je Steuerfall (Vorbild: Rechnungen MA000448 und MA000455)
const LEXOFFICE_STEUER = {
  "DE-19": { taxType: "net", satz: 19, vermerk: "" },
  "EU-19": { taxType: "net", satz: 19, vermerk: "" },
  "EU-RC": { taxType: "intraCommunitySupply", satz: 0, vermerk: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge), Zusammenfassende Meldung nicht vergessen" },
  "DRITT-netto": { taxType: "thirdPartyCountryService", satz: 0, vermerk: "Nicht im Inland steuerbare Leistung, Leistungsort Ausland (UStVA Kennzahl 45)" }
};

function pruefeAmpel({ payment, vorlage, preise, kontakt, steuerfreiErlaubt }) {
  const m = (payment && payment.metadata) || {};
  const gelb = [], rot = [];
  const steuer = steuerfallErmitteln(m, { volleUst: !!(vorlage && vorlage.volle_ust) });
  const lex = LEXOFFICE_STEUER[steuer.code] || null;

  // rot: Zahlung selbst ungewöhnlich
  if (payment.status !== "paid") rot.push(`Zahlung hat den Status "${payment.status}"`);
  if (cent((payment.amountRefunded || {}).value) > 0) rot.push("Es wurde schon etwas erstattet");
  if (payment.amount && payment.amount.currency !== "EUR") rot.push(`Währung ${payment.amount.currency}`);

  if (!vorlage) gelb.push("Für dieses Produkt gibt es noch keine Rechnungsvorlage (rechnungsvorlagen.json)");

  // Steuerfall
  if (steuer.unklar) gelb.push(steuer.unklar);
  else if (!lex) gelb.push(`Steuerfall ${steuer.code} ist nicht hinterlegt`);
  else if (lex.satz === 0 && !steuerfreiErlaubt) gelb.push("Steuerfreie Rechnung (Reverse Charge oder Drittland) ist für den Webhook noch nicht freigeschaltet");
  const landWarnung = landAbgleich(m.country, zahlungsland(payment));
  if (landWarnung && steuer.code !== "DE-19") gelb.push(landWarnung);

  // Betrag
  const gezahlt = cent((payment.amount || {}).value);
  let nettoCent = null;
  const erwartet = erwartetePreise(preise, m.discountCode);
  if (erwartet.fehler) gelb.push(erwartet.fehler);
  else {
    nettoCent = erwartet.liste.find(n => (steuer.netto ? n : brutto(n)) === gezahlt) ?? null;
    if (nettoCent === null) {
      const soll = erwartet.liste.map(n => euro(steuer.netto ? n : brutto(n))).join(" oder ") || "(kein Preis hinterlegt)";
      gelb.push(`Betrag ${euro(gezahlt)} passt nicht zum Preis (erwartet ${soll}${m.discountCode ? " mit Code " + m.discountCode : ""})`);
    }
  }

  // Kontakt
  const k = kontakt || {};
  const roh = (k.kontakt && k.kontakt.roh) || null;
  if (k.ergebnis === "uebersprungen") gelb.push("Lexoffice-Kontakt wurde nicht geprüft");
  else if (k.ergebnis === "pruefen" || k.ergebnis === "fehler" || !k.ok) gelb.push("Lexoffice-Kontakt bitte prüfen (siehe oben)");
  else if (k.ergebnis === "neu" && !k.angelegt) gelb.push("Kontakt wurde nur im Probelauf geprüft, nicht angelegt");
  else if (!roh) gelb.push("Lexoffice-Kontakt fehlt");
  if (roh && k.ergebnis === "vorhanden") {
    if (roh.archived) gelb.push("Der Lexoffice-Kontakt ist archiviert");
    const zips = [...(((roh.addresses || {}).billing) || []), ...(((roh.addresses || {}).shipping) || [])].map(a => zipNorm(a.zip));
    if (m.zip && !zips.includes(zipNorm(m.zip))) gelb.push(`Adresse weicht vom Lexoffice-Kontakt ab (PLZ ${m.zip} steht dort nicht)`);
    const vatKontakt = vatNorm(roh.company && roh.company.vatRegistrationId);
    if (vatNorm(m.vatId) && vatKontakt && vatKontakt !== vatNorm(m.vatId)) gelb.push("USt-IdNr. weicht vom Lexoffice-Kontakt ab");
  }
  if (roh && lex && lex.satz === 0 && !(roh.company && roh.company.allowTaxFreeInvoices)) {
    gelb.push("Der Lexoffice-Kontakt erlaubt keine steuerfreien Rechnungen (nur Firmenkontakte mit Häkchen „steuerfreie Rechnungen erlaubt“)");
  }

  const farbe = rot.length ? "rot" : (gelb.length ? "gelb" : "gruen");
  return {
    farbe,
    gruende: [...rot, ...gelb],
    steuer,
    nettoCent,
    gezahltCent: gezahlt,
    taxType: lex ? lex.taxType : null,
    satz: lex ? lex.satz : null,
    vermerk: lex ? lex.vermerk : ""
  };
}

module.exports = { pruefeAmpel, erwartetePreise, LEXOFFICE_STEUER };
