const https = require("https");

const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY;
const BASE_URL = "https://lp.marit-alke.de";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params = new URLSearchParams(event.body);
  const firstName = (params.get("firstName") || "").trim();
  const lastName  = (params.get("lastName")  || "").trim();
  const email     = (params.get("email")     || "").trim();
  const company   = (params.get("company")   || "").trim();
  const street    = (params.get("street")    || "").trim();
  const zip       = (params.get("zip")       || "").trim();
  const city      = (params.get("city")      || "").trim();
  const country   = (params.get("country")   || "DE").trim();
  const vatId     = (params.get("vatId")     || "").trim();

  if (!firstName || !lastName || !email || !street || !zip || !city) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<p>Bitte fülle alle Pflichtfelder aus. <a href='javascript:history.back()'>Zurück</a></p>"
    };
  }

  const metadata = { firstName, lastName, email, company, street, zip, city, country, vatId };

  // Preis: vatId vorhanden + nicht-DE = 39,00 € netto (Reverse Charge / Drittland), sonst 46,41 € brutto
  const isNetPrice = !!vatId && country.toUpperCase() !== "DE";
  const amount = isNetPrice ? "39.00" : "46.41";

  try {
    const payment = await mollieRequest("POST", "/payments", {
      amount: { currency: "EUR", value: amount },
      description: "CCDD VIP-Letter 01.07.–31.12.2026",
      redirectUrl: `${BASE_URL}/ccdd-vip-newsletter/danke.html`,
      webhookUrl:  `${BASE_URL}/.netlify/functions/mollie-webhook`,
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
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: "<p>Fehler beim Erstellen der Zahlung. Bitte versuche es erneut oder schreib an hallo@marit-alke.de.</p>"
    };
  }
};

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
    if (payload) req.write(payload);
    req.end();
  });
}
