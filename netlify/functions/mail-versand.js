// Minimaler SMTP-Client für die Bestell-Info an Marit (Posteo, kein npm-Paket).
// 1:1 aus mollie-webhook-baukasten.js übernommen (AUTH PLAIN, Dot-Stuffing, eigenes Timeout).
// Servername ist "posteo.de", nicht "smtp.posteo.de" (den gibt es nicht, Ursache der fehlenden Info-Mails im September 2026).
const tls = require("tls");

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

    socket.setTimeout(8000, () => fail(new Error("SMTP Timeout")));
    socket.on("error", fail);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
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
            send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
            step = 2;
            break;
          case 2:
            if (code !== "235") throw new Error("Login fehlgeschlagen: " + last);
            send(`MAIL FROM:<${from}>`);
            step = 3;
            break;
          case 3:
            if (code !== "250") throw new Error("MAIL FROM fehlgeschlagen: " + last);
            send(`RCPT TO:<${to}>`);
            step = 4;
            break;
          case 4:
            if (code !== "250") throw new Error("RCPT TO fehlgeschlagen: " + last);
            send("DATA");
            step = 5;
            break;
          case 5:
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
            step = 6;
            break;
          case 6:
            if (code !== "250") throw new Error("Senden fehlgeschlagen: " + last);
            send("QUIT");
            step = 7;
            break;
          case 7:
            done();
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

module.exports = { sendMail };
