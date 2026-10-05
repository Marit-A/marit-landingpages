const https = require("https");
const { produkte } = require("./baukasten-produkte.json");

// Baukasten: ein Bezahl-Code für alle neuen Produkte. Preis, Mollie-Text und
// Danke-Seite kommen aus baukasten-produkte.json, das Formular schickt nur den
// Produkt-Schlüssel mit (verstecktes Feld "produkt"). Die älteren Checkouts
// (VIP-Letter, DEEP DESIGN, Vibe-Coding) haben weiterhin eigene Dateien.
// USt-IdNr.-Prüfung und Reverse-Charge-Logik 1:1 aus create-payment-vibe-coding.js.
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY_BAUKASTEN;
const BASE_URL = "https://lp.marit-alke.de";

function centsToStr(cents) {
  return (cents / 100).toFixed(2);
}

// Mitgliedsstaaten, die die EU-VIES-Datenbank abdeckt (inkl. "EL" für Griechenland und "XI" für Nordirland)
const VIES_COUNTRIES = ["AT","BE","BG","CY","CZ","DE","DK","EE","EL","ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params = new URLSearchParams(event.body);

  const schluessel = (params.get("produkt") || "").trim();
  const produkt = Object.prototype.hasOwnProperty.call(produkte, schluessel) ? produkte[schluessel] : null;
  if (!produkt || !Number.isInteger(produkt.netto_cent) || produkt.netto_cent <= 0) {
    return errorPage("Dieses Produkt konnte nicht gefunden werden. Bitte lade die Bestellseite neu oder schreib an info@marit-alke.de.");
  }

  // Verkaufsende (optional): "verkauf_bis" gilt inklusive, Zeit Europe/Berlin
  if (produkt.verkauf_bis) {
    const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    if (heute > produkt.verkauf_bis) {
      return errorPage("Die Buchung für dieses Angebot ist leider beendet. Bei Fragen schreib an info@marit-alke.de.");
    }
  }

  const firstName = (params.get("firstName") || "").trim();
  const lastName  = (params.get("lastName")  || "").trim();
  const email     = (params.get("email")     || "").trim();
  const company   = (params.get("company")   || "").trim();
  const street    = (params.get("street")    || "").trim();
  const zip       = (params.get("zip")       || "").trim();
  const city      = (params.get("city")      || "").trim();
  const country   = (params.get("country")   || "DE").trim();
  const vatIdRaw  = (params.get("vatId")     || "").trim();
  const vatId     = vatIdRaw.toUpperCase().replace(/[\s.\-]/g, "");

  if (!firstName || !lastName || !email || !street || !zip || !city) {
    return errorPage("Bitte fülle alle Pflichtfelder aus.");
  }

  // Digitale Inhalte (z. B. Selbstlernkurse): Das Widerrufsrecht erlischt nur, wenn
  // die Käuferin dem sofortigen Beginn ausdrücklich zustimmt. Das Formular verlangt
  // das Häkchen schon, hier wird es noch einmal geprüft und in der Zahlung bei
  // Mollie festgehalten (metadata.widerrufVerzicht).
  const widerrufVerzicht = params.get("widerruf") === "on";
  if (produkt.digitaler_inhalt && !widerrufVerzicht) {
    return errorPage("Bitte bestätige mit dem Häkchen, dass der Kurs sofort freigeschaltet werden darf.");
  }

  // Rabattcode (optional): Nur der Code-Text aus dem Formular zählt, der Betrag kommt
  // ausschließlich aus baukasten-produkte.json (die Vorschau im Browser ist unverbindlich).
  const codeEingabe = (params.get("discountCode") || "").trim().toUpperCase();
  let rabatt = null;
  let rabattCode = "";
  if (codeEingabe) {
    const codes = produkt.rabattcodes || {};
    if (!Object.prototype.hasOwnProperty.call(codes, codeEingabe)) {
      return errorPage("Dieser Rabattcode ist nicht gültig. Bitte prüfe die Eingabe oder lass das Feld leer.");
    }
    rabatt = codes[codeEingabe];
    rabattCode = codeEingabe;
  }

  const priceNetCents   = produkt.netto_cent - (rabatt ? rabatt.abzug_netto_cent : 0);
  if (!Number.isInteger(priceNetCents) || priceNetCents <= 0) {
    return errorPage("Der Preis konnte nicht berechnet werden. Bitte schreib an info@marit-alke.de.");
  }
  const priceGrossCents = Math.round(priceNetCents * 1.19);

  const priceNet   = centsToStr(priceNetCents);
  const priceGross = centsToStr(priceGrossCents);

  // ── USt-IdNr.-Prüfung ────────────────────────────────────────────────────
  // Reverse Charge gilt nur für grenzüberschreitende B2B-Geschäfte innerhalb der EU
  // (Art. 44 MwStSystRL) bzw. für Drittland-Geschäfte (steuerfreie Ausfuhrlieferung).
  // Maßgeblich ist das Länderkürzel der USt-IdNr. selbst (nicht das gewählte Land im
  // Adressfeld), weil das die tatsächliche steuerliche Registrierung abbildet.
  let reverseCharge = false;
  let vatValidated  = false;
  let vatCheckNote   = "";

  if (vatId) {
    const vatFormatOk = /^[A-Z]{2}[A-Z0-9]{2,}$/.test(vatId);
    if (!vatFormatOk) {
      return errorPage("Die USt-IdNr. hat nicht das erwartete Format (Ländercode + Nummer, z. B. ATU12345678). Bitte korrigiere die Eingabe oder lass das Feld leer.");
    }

    const vatPrefix = vatId.slice(0, 2);

    if (vatPrefix === "DE") {
      // Inländisches Geschäft – kein Reverse Charge, unabhängig von der USt-IdNr.
      reverseCharge = false;
    } else if (VIES_COUNTRIES.includes(vatPrefix)) {
      // EU-Ausland (oder Nordirland): verpflichtend gegen VIES prüfen
      let viesResult;
      try {
        viesResult = await checkViesVat(vatPrefix, vatId.slice(2));
      } catch (err) {
        console.error("VIES nicht erreichbar:", err.message);
        return errorPage("Die USt-ID-Prüfung ist gerade nicht erreichbar. Bitte versuche es in ein paar Minuten erneut, oder lass das Feld leer und bestelle regulär inkl. MwSt. (bei nachgewiesener Berechtigung erstatten wir die MwSt. auf Anfrage).");
      }

      if (viesResult.transient) {
        // z.B. SERVICE_UNAVAILABLE, MS_UNAVAILABLE, TIMEOUT, MS_MAX_CONCURRENT_REQ:
        // der jeweilige Mitgliedsstaat/Dienst ist gerade nicht erreichbar, das ist keine
        // Aussage über die Gültigkeit der Nummer. Nicht automatisch ablehnen oder gewähren.
        console.error("VIES vorübergehend nicht verfügbar:", viesResult.userError);
        return errorPage("Die USt-ID-Prüfung ist beim zuständigen EU-Mitgliedsstaat gerade nicht erreichbar (Grund: " + viesResult.userError + "). Bitte versuche es in ein paar Minuten erneut, oder lass das Feld leer und bestelle regulär inkl. MwSt.");
      }

      if (!viesResult.valid) {
        return errorPage("Deine USt-IdNr. konnte über die EU-VIES-Datenbank nicht bestätigt werden (Grund: " + viesResult.userError + "). Bitte prüfe die Eingabe, oder lass das Feld leer, um regulär inkl. MwSt. zu bestellen.");
      }

      reverseCharge = true;
      vatValidated  = true;
      vatCheckNote  = viesResult.name ? `VIES bestätigt: ${viesResult.name}` : "VIES bestätigt";
    } else {
      // Drittland (z.B. Schweiz, UK, USA) – VIES deckt das nicht ab, gilt als
      // steuerfreie Ausfuhrlieferung/Dienstleistung an Drittland (dokumentierte Annahme)
      reverseCharge = true;
    }
  }

  const finalPrice = reverseCharge ? priceNet : priceGross;

  const metadata = {
    product: produkt.kennung,
    firstName, lastName, email, company, street, zip, city, country,
    vatId, reverseCharge: String(reverseCharge), vatValidated: String(vatValidated), vatCheckNote,
    widerrufVerzicht: String(widerrufVerzicht),
    discountCode: rabattCode
  };

  try {
    const payment = await mollieRequest("POST", "/payments", {
      amount: { currency: "EUR", value: finalPrice },
      description: produkt.name,
      redirectUrl: `${BASE_URL}/${produkt.seite}/danke.html`,
      webhookUrl:  `${BASE_URL}/.netlify/functions/mollie-webhook-baukasten`,
      metadata,
      locale: "de_DE"
    });

    return {
      statusCode: 302,
      headers: { Location: payment._links.checkout.href },
      body: ""
    };
  } catch (err) {
    console.error("Mollie Fehler:", err.message);
    return errorPage("Fehler beim Erstellen der Zahlung. Bitte versuche es erneut oder schreib an info@marit-alke.de.");
  }
};

function errorPage(message) {
  return {
    statusCode: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<p>${message}</p><p><a href="javascript:history.back()">Zurück zum Formular</a></p>`
  };
}

// ── EU-VIES USt-IdNr.-Prüfung ────────────────────────────────────────────────
// Kostenlose öffentliche REST-API der EU-Kommission, kein API-Key nötig.
// userError-Codes der VIES-REST-API, die eine vorübergehende Nichtverfügbarkeit
// des jeweiligen Mitgliedsstaats/Dienstes anzeigen (keine Aussage zur Gültigkeit der Nummer)
const VIES_TRANSIENT_ERRORS = ["SERVICE_UNAVAILABLE", "MS_UNAVAILABLE", "TIMEOUT", "GLOBAL_MAX_CONCURRENT_REQ", "MS_MAX_CONCURRENT_REQ", "IE_ERROR"];

function checkViesVat(countryCode, vatNumber) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "ec.europa.eu",
      path: `/taxation_customs/vies/rest-api/ms/${countryCode}/vat/${encodeURIComponent(vatNumber)}`,
      method: "GET",
      timeout: 6000
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`VIES ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve({
            valid: parsed.isValid === true,
            name: parsed.name && parsed.name !== "---" ? parsed.name : "",
            userError: parsed.userError || "",
            transient: VIES_TRANSIENT_ERRORS.includes(parsed.userError)
          });
        } catch (e) {
          reject(new Error(`VIES Antwort nicht lesbar: ${data}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("VIES Timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function mollieRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.mollie.com",
      path: `/v2${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Mollie ${res.statusCode}: ${data}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error(`Mollie-Anfrage Timeout: ${path}`)));
    if (payload) req.write(payload);
    req.end();
  });
}
