const https = require("https");
const { kaufAblauf } = require("./kauf-ablauf.js");
const { sendMail } = require("./mail-versand.js");

const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;
const GR_CAMPAIGN_ID      = "7M5Vz"; // CCDD VIP-Letter
const GR_TAG_NAME         = "vip_newsletter";

// Bestell-Info an Marit (seit 25.11.2026, vorher kam nur die Mollie-eigene Benachrichtigung),
// mit dem Ergebnis des Kaufablaufs (Lexoffice-Kontakt, Ampel, Rechnungsentwurf).
const POSTEO_EMAIL    = process.env.POSTEO_EMAIL;
const POSTEO_PASSWORD = process.env.POSTEO_PASSWORD;
const NOTIFY_TO       = "info@marit-alke.de";
const PRODUKT_NAME    = "CCDD VIP-Letter";

exports.handler = async (event) => {
  const start = Date.now();
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

  const { firstName = "", lastName = "", email = "" } = payment.metadata || {};

  if (!email) {
    console.error("Keine E-Mail in Payment-Metadata");
    return { statusCode: 200, body: "OK" };
  }

  // GetResponse und Kaufablauf (Lexoffice-Kontakt, Ampel, bei Grün Rechnungsentwurf) parallel,
  // danach die Bestell-Info mit dem Ergebnis
  const [, ablauf] = await Promise.all([
    (async () => {
      try {
        const tagId = await getOrCreateTag(GR_TAG_NAME);
        await upsertContact(email, firstName, GR_CAMPAIGN_ID, tagId);
        console.log(`GetResponse OK: ${email}`);
      } catch (err) {
        console.error("GetResponse Fehler:", err.message);
      }
    })(),
    kaufAblauf({ payment, kennung: "vip_letter", produktName: PRODUKT_NAME, mollieKey: MOLLIE_API_KEY, start })
  ]);
  await sendNotificationMail(payment, ablauf);

  return { statusCode: 200, body: "OK" };
};

// ── Bestell-Info an Marit ────────────────────────────────────────────────────

async function sendNotificationMail(payment, ablauf) {
  if (!(POSTEO_EMAIL && POSTEO_PASSWORD)) {
    console.log("Benachrichtigungsmail übersprungen: POSTEO_EMAIL/POSTEO_PASSWORD nicht gesetzt");
    return;
  }
  try {
    const { subject, text } = buildNotificationEmail(payment, ablauf);
    await sendMail({ host: "posteo.de", port: 465, user: POSTEO_EMAIL, pass: POSTEO_PASSWORD, from: POSTEO_EMAIL, to: NOTIFY_TO, subject, text });
    console.log("Bestell-Benachrichtigung OK");
  } catch (err) {
    console.error("Benachrichtigungsmail Fehler:", err.message);
  }
}

function buildNotificationEmail(payment, ablauf) {
  const m = payment.metadata || {};
  const kontakt = ablauf && ablauf.kontakt;
  const rechnung = (ablauf && ablauf.rechnungZeilen) || [];
  const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "(unbekannt)";
  const amount = payment.amount ? `${payment.amount.value} ${payment.amount.currency}` : "(unbekannt)";
  const dashboardUrl = payment._links && payment._links.dashboard ? payment._links.dashboard.href : "";
  const rechnungsText = `Hallo${m.firstName ? " " + m.firstName : ""},\n\ndanke für deinen Kauf! Anbei deine Rechnung.\n\nWenn du Fragen oder Anregungen hast, melde dich gern.`;
  const antwortLink = m.email
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(m.email)}&su=${encodeURIComponent("Anbei deine Rechnung für " + PRODUKT_NAME)}&body=${encodeURIComponent(rechnungsText)}`
    : null;
  const lines = [
    `Neue Bestellung: ${PRODUKT_NAME}`,
    ``,
    `Name: ${name}`,
    `E-Mail: ${m.email || "(unbekannt)"}`,
    `Firma: ${m.company || "(keine)"}`,
    `Adresse: ${m.street || ""}, ${m.zip || ""} ${m.city || ""}, ${m.country || ""}`,
    `USt-IdNr.: ${m.vatId || "(keine)"}${m.vatId ? " (nicht über VIES geprüft)" : ""}`,
    `Zahlbetrag: ${amount}`,
    kontakt && kontakt.ergebnis !== "uebersprungen" ? `Lexoffice-Kontakt: ${kontakt.text}` : null,
    `Mollie Payment-ID: ${payment.id || "(unbekannt)"}`,
    dashboardUrl ? `Mollie Dashboard: ${dashboardUrl}` : null,
    antwortLink ? `Rechnung an den Kunden senden (Link öffnet Gmail mit neuer Mail): ${antwortLink}` : null,
    ``,
    ...(rechnung.length ? rechnung : [`Rechnung bitte wie gewohnt manuell in Lexoffice erstellen.`])
  ].filter(line => line !== null);
  return {
    subject: `${kontakt && !kontakt.ok ? "⚠️ Lexoffice-Kontakt prüfen! " : ""}Neue Bestellung VIP-Letter: ${name}${(ablauf && ablauf.betreffZusatz) || ""}`,
    text: lines.join("\n")
  };
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
    req.setTimeout(8000, () => req.destroy(new Error(`Mollie-Anfrage Timeout: ${path}`)));
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
