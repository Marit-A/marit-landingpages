const https = require("https");

const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;
const GR_CAMPAIGN_ID      = "7M5Vz"; // CCDD VIP-Letter
const GR_TAG_NAME         = "vip_newsletter";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params    = new URLSearchParams(event.body);
  const paymentId = params.get("id");

  if (!paymentId) {
    return { statusCode: 400, body: "Kein Payment-ID" };
  }

  let payment;
  try {
    payment = await mollieRequest("GET", `/payments/${paymentId}`);
  } catch (err) {
    console.error("Mollie fetch Fehler:", err.message);
    // 200 zurückgeben damit Mollie NICHT wiederholt – bei "wrong mode" wäre ein Retry sinnlos
    if (err.message.includes("404") || err.message.includes("wrong mode")) {
      return { statusCode: 200, body: "OK – ignoriert (404/mode mismatch)" };
    }
    return { statusCode: 500, body: "Fehler" };
  }

  if (payment.status !== "paid") {
    console.log(`Payment ${paymentId} status: ${payment.status} – ignoriert`);
    return { statusCode: 200, body: "OK" };
  }

  const { firstName = "", lastName = "", email = "", company = "",
          street = "", zip = "", city = "", country = "DE", vatId = "" } = payment.metadata || {};

  if (!email) {
    console.error("Keine E-Mail in Payment-Metadata");
    return { statusCode: 200, body: "OK" };
  }

  // 1. GetResponse
  try {
    const tagId = await getOrCreateTag(GR_TAG_NAME);
    await upsertContact(email, firstName, GR_CAMPAIGN_ID, tagId);
    console.log(`GetResponse OK: ${email}`);
  } catch (err) {
    console.error("GetResponse Fehler:", err.message);
    // Nicht abbrechen – Rechnung trotzdem versuchen
  }

  // 2. Mollie Sales Invoice (Beta)
  try {
    await createSalesInvoice({ paymentId, firstName, lastName, email, company, street, zip, city, country, vatId });
    console.log(`Rechnung erstellt: ${email}`);
  } catch (err) {
    console.error("Invoice Fehler:", err.message);
    // Nicht fatal – Rechnung kann manuell nachgeholt werden
  }

  return { statusCode: 200, body: "OK" };
};

// ── Mollie Sales Invoice ──────────────────────────────────────────────────────

async function createSalesInvoice({ paymentId, firstName, lastName, email, company, street, zip, city, country, vatId }) {
  const recipientName = company || `${firstName} ${lastName}`;
  const isEuBusiness  = !!vatId;
  const vatRate       = isEuBusiness ? "0.00" : "19.00";

  const body = {
    status: "paid",
    vatMode: "exclusive",
    recipientIdentifier: email,
    recipient: {
      type: company ? "business" : "consumer",
      name: recipientName,
      email,
      address: {
        streetAndNumber: street,
        postalCode: zip,
        city,
        country: country || "DE"
      }
    },
    lines: [
      {
        type: "digital",
        name: "CCDD VIP-Letter",
        description: "Exklusiver Newsletter mit Impulsen zu Claude Cowork und KI-Tools, 01.07.–31.12.2026",
        quantity: 1,
        unitPrice: { currency: "EUR", value: "39.00" },
        vatRate
      }
    ],
    paymentDetails: {
      source: "payment",
      sourceReference: paymentId,
      paymentId
    },
    emailDetails: {
      subject: "Deine Rechnung – CCDD VIP-Letter",
      body: `Hallo ${firstName},\n\nvielen Dank für deine Bestellung! Im Anhang findest du deine Rechnung für den CCDD VIP-Letter (01.07.–31.12.2026).\n\nDu erhältst in Kürze eine weitere E-Mail mit allen Infos zum Newsletter.\n\nHerzliche Grüße\nMarit Alke`
    }
  };

  if (isEuBusiness) {
    body.memo = `Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge). USt-IdNr.: ${vatId}`;
  }

  await mollieRequest("POST", "/sales-invoices", body);
}

// ── GetResponse ───────────────────────────────────────────────────────────────

async function getOrCreateTag(name) {
  const tags = await grRequest("GET", `/tags?query[name]=${encodeURIComponent(name)}`);
  if (Array.isArray(tags) && tags.length > 0) return tags[0].tagId;
  const newTag = await grRequest("POST", "/tags", { name });
  return newTag.tagId;
}

async function upsertContact(email, firstName, campaignId, tagId) {
  const body = { email, name: firstName, campaign: { campaignId }, tags: [{ tagId }], dayOfCycle: "0" };
  const status = await grRequestWithStatus("POST", "/contacts", body);
  if (status === 409) {
    const contact = await getContactByEmail(email);
    if (contact) {
      await grRequest("POST", `/contacts/${contact.contactId}/tags`, { tags: [{ tagId }] });
    }
  }
}

async function getContactByEmail(email) {
  const list = await grRequest("GET", `/contacts?query[email]=${encodeURIComponent(email)}&additionalFlags=exactMatch`);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

// ── HTTP Helfer ───────────────────────────────────────────────────────────────

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
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`Mollie ${res.statusCode}: ${data}`)); return; }
        resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function grRequestWithStatus(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.getresponse.com",
      path: `/v3${path}`,
      method,
      headers: {
        "X-Auth-Token": `api-key ${GETRESPONSE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function grRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.getresponse.com",
      path: `/v3${path}`,
      method,
      headers: {
        "X-Auth-Token": `api-key ${GETRESPONSE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`GetResponse ${res.statusCode}: ${data}`)); return; }
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
