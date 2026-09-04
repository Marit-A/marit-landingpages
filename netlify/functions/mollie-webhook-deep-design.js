const https = require("https");
const tls   = require("tls");

const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY_DEEP_DESIGN;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;
const GR_CAMPAIGN_ID      = "7mzut"; // DEEP DESIGN Workshop
const GR_TAG_NAME         = "deep_design_teilnehmerin";

// Bestell-Benachrichtigung per E-Mail (04.09.2026): damit Marit die Rechnungsadresse
// nicht mehr mühsam aus der Mollie-Benachrichtigungsmail rauskopieren muss, verschickt
// der Webhook bei jeder erfolgreichen Zahlung zusätzlich eine eigene Mail mit allen
// Metadaten über Posteo (SMTP, kein npm-Paket nötig, wie der Rest der Functions ohne
// externe Dependencies auskommt).
const POSTEO_EMAIL    = process.env.POSTEO_EMAIL;
const POSTEO_PASSWORD = process.env.POSTEO_PASSWORD;
const NOTIFY_TO       = "info@marit-alke.de";

// Rechnungsstellung: aktuell bewusst NICHT automatisiert (Mollie Sales Invoice API
// ist Beta und instabil, s. MOLLIE-SETUP.md). Marit erstellt Rechnungen manuell in
// Lexoffice anhand der Mollie-Benachrichtigungsmail bzw. des Mollie-Dashboards.

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
    // Bei dauerhaften Fehlern (z.B. 404, falscher Modus) 200 zurückgeben,
    // sonst wiederholt Mollie den Webhook-Aufruf stundenlang.
    if (err.message.includes("404")) return { statusCode: 200, body: "OK" };
    return { statusCode: 500, body: "Fehler" };
  }

  if (payment.status !== "paid") {
    console.log(`Payment ${paymentId} status: ${payment.status} – ignoriert`);
    return { statusCode: 200, body: "OK" };
  }

  const { firstName = "", email = "" } = payment.metadata || {};

  if (!email) {
    console.error("Keine E-Mail in Payment-Metadata");
    return { statusCode: 200, body: "OK" };
  }

  try {
    const tagId = await getOrCreateTag(GR_TAG_NAME);
    await upsertContact(email, firstName, GR_CAMPAIGN_ID, tagId);
    console.log(`GetResponse OK: ${email}`);
  } catch (err) {
    console.error("GetResponse Fehler:", err.message);
  }

  if (POSTEO_EMAIL && POSTEO_PASSWORD) {
    try {
      const { subject, text } = buildNotificationEmail(payment);
      await sendMail({
        host: "smtp.posteo.de",
        port: 465,
        user: POSTEO_EMAIL,
        pass: POSTEO_PASSWORD,
        from: POSTEO_EMAIL,
        to: NOTIFY_TO,
        subject,
        text
      });
      console.log("Bestell-Benachrichtigung OK");
    } catch (err) {
      // Nie den Webhook scheitern lassen, wenn nur die Benachrichtigungsmail fehlschlägt –
      // die eigentliche Bestellung (GetResponse) ist bereits durch, das ist nur ein
      // zusätzlicher Komfort-Hinweis für Marit.
      console.error("Benachrichtigungsmail Fehler:", err.message);
    }
  } else {
    console.log("Benachrichtigungsmail übersprungen: POSTEO_EMAIL/POSTEO_PASSWORD nicht gesetzt");
  }

  return { statusCode: 200, body: "OK" };
};

// ── Bestell-Benachrichtigung per E-Mail ─────────────────────────────────────────

function buildNotificationEmail(payment) {
  const m = payment.metadata || {};
  const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "(unbekannt)";
  const amount = payment.amount ? `${payment.amount.value} ${payment.amount.currency}` : "(unbekannt)";
  const dashboardUrl = payment._links && payment._links.dashboard ? payment._links.dashboard.href : "";

  const discountLine = m.discountCode
    ? `${m.discountCode} (−${m.discountAmountNet || "?"} € netto)`
    : "(keiner)";
  const vatLine = m.vatId
    ? `${m.vatId}${m.vatValidated === "true" && m.vatCheckNote ? " (" + m.vatCheckNote + ")" : ""}`
    : "(keine)";

  const lines = [
    `Neue Bestellung: DEEP DESIGN Workshop`,
    ``,
    `Name: ${name}`,
    `E-Mail: ${m.email || "(unbekannt)"}`,
    `Firma: ${m.company || "(keine)"}`,
    `Adresse: ${m.street || ""}, ${m.zip || ""} ${m.city || ""}, ${m.country || ""}`,
    `USt-IdNr.: ${vatLine}`,
    `Reverse Charge: ${m.reverseCharge === "true" ? "ja" : "nein"}`,
    `Preis-Tier: ${m.priceTier || "(unbekannt)"}`,
    `Rabattcode: ${discountLine}`,
    `Zahlbetrag: ${amount}`,
    `Mollie Payment-ID: ${payment.id || "(unbekannt)"}`,
    dashboardUrl ? `Mollie Dashboard: ${dashboardUrl}` : null,
    ``,
    `Rechnung bitte wie gewohnt manuell in Lexoffice erstellen.`
  ].filter(line => line !== null);

  return {
    subject: `Neue Bestellung: ${name}${m.discountCode ? " (" + m.discountCode + ")" : ""}`,
    text: lines.join("\n")
  };
}

// ── Minimaler SMTP-Client (Posteo, kein npm-Paket) ──────────────────────────────
// Getestet gegen einen lokalen Mock-SMTP-Server (Mehrzeilen-EHLO-Antwort, AUTH LOGIN,
// Dot-Stuffing bei Zeilen, die mit "." beginnen, UTF-8-Betreff via MIME encoded-word).
// Gegen den echten smtp.posteo.de konnte das nicht getestet werden, da weder die
// Cloud-Sandbox noch die Geräte-Shell rohes TCP auf Port 465 erlauben (nur erlaubte
// HTTPS-Hosts) – Netlify Functions haben aber uneingeschränkten Outbound-Zugriff
// (dieselbe Umgebung ruft bereits erfolgreich api.mollie.com/api.getresponse.com auf),
// daher sollte die Verbindung dort funktionieren.

function sendMail({ host, port, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {});
    let buffer = "";
    let step = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      reject(err);
    }
    function done() {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (e) {}
      resolve();
    }
    function send(line) { socket.write(line + "\r\n"); }
    const b64 = s => Buffer.from(s, "utf8").toString("base64");

    socket.setTimeout(15000, () => fail(new Error("SMTP Timeout")));
    socket.on("error", fail);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // Erst wenn der Puffer mit CRLF endet, kann er überhaupt eine vollständige Zeile
      // enthalten – sonst könnte ein TCP/TLS-Segment mitten in einer Zeile aufgehört
      // haben und ein zufällig wie "250 " aussehendes Fragment (vor dem eigentlichen
      // Text der Zeile) würde fälschlich als vollständige Antwort durchgehen.
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return; // auf vollständige (ggf. mehrzeilige) Antwort warten
      const code = last.slice(0, 3);
      buffer = "";

      try {
        switch (step) {
          case 0:
            if (code !== "220") throw new Error("Unerwartete Begrüßung: " + last);
            send(`EHLO lp.marit-alke.de`);
            step = 1;
            break;
          case 1:
            if (code !== "250") throw new Error("EHLO fehlgeschlagen: " + last);
            send("AUTH LOGIN");
            step = 2;
            break;
          case 2:
            if (code !== "334") throw new Error("AUTH LOGIN fehlgeschlagen: " + last);
            send(b64(user));
            step = 3;
            break;
          case 3:
            if (code !== "334") throw new Error("Username abgelehnt: " + last);
            send(b64(pass));
            step = 4;
            break;
          case 4:
            if (code !== "235") throw new Error("Login fehlgeschlagen: " + last);
            send(`MAIL FROM:<${from}>`);
            step = 5;
            break;
          case 5:
            if (code !== "250") throw new Error("MAIL FROM fehlgeschlagen: " + last);
            send(`RCPT TO:<${to}>`);
            step = 6;
            break;
          case 6:
            if (code !== "250") throw new Error("RCPT TO fehlgeschlagen: " + last);
            send("DATA");
            step = 7;
            break;
          case 7:
            if (code !== "354") throw new Error("DATA fehlgeschlagen: " + last);
            {
              const subjEnc = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
              const headers = [
                `From: ${from}`,
                `To: ${to}`,
                `Subject: ${subjEnc}`,
                `Date: ${new Date().toUTCString()}`,
                `Content-Type: text/plain; charset=UTF-8`,
                `MIME-Version: 1.0`,
                ""
              ].join("\r\n");
              const escapedBody = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n").replace(/^\./gm, "..");
              socket.write(headers + "\r\n" + escapedBody + "\r\n.\r\n");
            }
            step = 8;
            break;
          case 8:
            if (code !== "250") throw new Error("Senden fehlgeschlagen: " + last);
            send("QUIT");
            step = 9;
            break;
          case 9:
            done();
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
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
