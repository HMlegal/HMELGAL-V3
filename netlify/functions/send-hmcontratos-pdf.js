const Busboy = require("busboy");
const nodemailer = require("nodemailer");

function isPdf(buffer) {
  // Magic number %PDF
  return buffer?.length >= 4 &&
    buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const contentType = event.headers["content-type"] || event.headers["Content-Type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    return { statusCode: 400, body: "Expected multipart/form-data" };
  }

  const bb = Busboy({ headers: { "content-type": contentType } });

  let pdfFile = null;
  const fields = {};
  const filePromises = [];

  const body = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");

  bb.on("file", (name, file, info) => {
    const { filename, mimeType } = info;
    const chunks = [];
    file.on("data", (d) => chunks.push(d));

    filePromises.push(new Promise((resolve) => {
      file.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (name === "pdf") {
          pdfFile = { filename: filename || "documento.pdf", mimeType, buffer };
        }
        resolve();
      });
    }));
  });

  bb.on("field", (name, val) => { fields[name] = val; });

  const finished = new Promise((resolve, reject) => {
    bb.on("finish", resolve);
    bb.on("error", reject);
  });

  bb.end(body);
  await finished;
  await Promise.all(filePromises);

  if (!pdfFile?.buffer) return { statusCode: 400, body: "Missing PDF file" };

  // Validate PDF
  if (pdfFile.mimeType !== "application/pdf" || !isPdf(pdfFile.buffer)) {
    return { statusCode: 400, body: "Only valid PDF files are allowed" };
  }

  // Gmail Workspace SMTP
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true", // false for 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS, // App Password (16 chars)
    },
  });

  const toEmail = "contacto@hmlegal.cl";
  const fromEmail = process.env.MAIL_FROM || process.env.SMTP_USER || "contacto@hmlegal.cl";

  const signerCount = Math.max(1, Math.min(3, parseInt(fields.signerCount, 10) || 1));

  let signersText = "";
  for (let i = 1; i <= signerCount; i++) {
    const n = (fields[`signer_name_${i}`] || "").trim();
    const e = (fields[`signer_email_${i}`] || "").trim();
    signersText += `Firmante #${i}: ${n} <${e}>\n`;
  }

  const mailOptions = {
    from: fromEmail,
    to: toEmail,
    subject: "HMcontratos USO ÚNICO.",
    text:
`Nueva solicitud HMContratos (USO ÚNICO)

Número de firmantes: ${signerCount}

${signersText}
Origen: ${fields.source || "hmcontratos/firmar.html"}
Fecha: ${new Date().toISOString()}
`,
    attachments: [{
      filename: pdfFile.filename,
      content: pdfFile.buffer,
      contentType: "application/pdf",
    }],
  };

  try {
    await transporter.sendMail(mailOptions);
    return { statusCode: 200, body: "OK" };
  } catch (err) {
    // Devuelve mensaje útil para debug (sin exponer credenciales)
    return { statusCode: 500, body: "Email send failed: " + (err?.message || "unknown") };
  }
};
