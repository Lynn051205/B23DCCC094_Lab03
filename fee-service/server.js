const http = require("node:http");
const https = require("node:https");

const PORT = Number(process.env.PORT || 4001);
const BANK_TIMEOUT_MS = 4_500;
const MAX_BODY_BYTES = 1_000_000;
const BANK_URL = process.env.BANK_URL || "http://localhost:4002";

let bankUrl;
try {
  bankUrl = new URL(BANK_URL);
  if (bankUrl.protocol !== "http:" && bankUrl.protocol !== "https:") {
    throw new Error("BANK_URL chỉ hỗ trợ giao thức http hoặc https.");
  }
} catch (error) {
  console.error(`BANK_URL không hợp lệ: ${error.message}`);
  process.exit(1);
}

const bankAgents = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: 20 }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: 20 }),
};

const students = new Map([
  ["1", { balance: 50_000_000, reserved: 0 }],
  ["2", { balance: 0, reserved: 0 }],
  ["3", { balance: 3_200_000, reserved: 0 }],
]);

const payments = new Map();
const paymentsByClientKey = new Map();
let nextPaymentNumber = 1;

const sendJson = (res, statusCode, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readJsonBody = async (req) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Nội dung yêu cầu vượt quá giới hạn cho phép.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Nội dung JSON không hợp lệ.");
    error.statusCode = 400;
    throw error;
  }
};

const paymentResponse = (payment) => ({
  paymentId: payment.paymentId,
  studentId: payment.studentId,
  amount: payment.amount,
  status: payment.status,
  ...(payment.charge ? { charge: payment.charge } : {}),
  ...(payment.error ? { error: payment.error } : {}),
});

const sendStoredPayment = (res, payment) => {
  const statusCode =
    payment.status === "PAID"
      ? 201
      : payment.status === "PENDING"
        ? 504
        : payment.httpStatus || 500;
  sendJson(res, statusCode, paymentResponse(payment));
};

const isDefinitelyUnsent = (error) =>
  [
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ].includes(error.code);

const chargeBank = (payment) =>
  new Promise((resolve) => {
    const client = bankUrl.protocol === "https:" ? https : http;
    const requestUrl = new URL("/charges", bankUrl);
    const body = JSON.stringify({
      reference: payment.paymentId,
      amount: payment.amount,
    });
    let settled = false;
    let socketConnected = false;
    let requestWritten = false;
    let timeoutHandle;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const request = client.request(
      requestUrl,
      {
        method: "POST",
        agent: bankAgents[bankUrl.protocol],
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Idempotency-Key": `fee-payment-${payment.paymentId}`,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", (error) =>
          finish({ kind: "unknown", error: error.message }),
        );
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let responseBody;
          try {
            responseBody = rawBody ? JSON.parse(rawBody) : {};
          } catch {
            responseBody = {};
          }

          finish({
            kind: "response",
            statusCode: response.statusCode || 502,
            body: responseBody,
          });
        });
      },
    );

    request.on("socket", (socket) => {
      if (!socket.connecting) {
        socketConnected = true;
      } else {
        socket.once("connect", () => {
          socketConnected = true;
        });
      }
    });
    request.on("finish", () => {
      requestWritten = true;
    });

    timeoutHandle = setTimeout(() => {
      const error = new Error("Ngân hàng không phản hồi trong 4,5 giây.");
      error.code = "BANK_TIMEOUT";
      request.destroy(error);
      finish(
        requestWritten || socketConnected
          ? { kind: "unknown", error: error.message }
          : { kind: "unavailable", error: error.message },
      );
    }, BANK_TIMEOUT_MS);

    request.on("error", (error) => {
      if (isDefinitelyUnsent(error)) {
        finish({ kind: "unavailable", error: error.message });
      } else if (error.code === "BANK_TIMEOUT") {
        finish({ kind: "unknown", error: error.message });
      } else {
        finish({ kind: "unknown", error: error.message });
      }
    });

    request.end(body);
  });

const handlePayment = async (req, res, studentId) => {
  const student = students.get(studentId);
  if (!student) {
    return sendJson(res, 404, {
      error: "Không tìm thấy sinh viên.",
      paymentId: null,
      status: "FAILED",
    });
  }

  const body = await readJsonBody(req);
  const amount = body && body.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return sendJson(res, 400, {
      error: "Số tiền thanh toán phải là số hợp lệ lớn hơn 0.",
      paymentId: null,
      status: "FAILED",
    });
  }

  const rawClientKey = req.headers["idempotency-key"];
  const clientKey =
    typeof rawClientKey === "string" ? rawClientKey.trim() : undefined;
  if (clientKey && paymentsByClientKey.has(clientKey)) {
    const previousPayment = payments.get(paymentsByClientKey.get(clientKey));
    if (
      previousPayment.studentId !== studentId ||
      previousPayment.amount !== amount
    ) {
      return sendJson(res, 409, {
        error: "Idempotency-Key đã được dùng cho dữ liệu thanh toán khác.",
        paymentId: previousPayment.paymentId,
        status: "FAILED",
      });
    }
    return sendStoredPayment(res, previousPayment);
  }

  if (amount > student.balance) {
    return sendJson(res, 400, {
      error: "Số tiền thanh toán vượt quá công nợ hiện tại.",
      paymentId: null,
      status: "FAILED",
    });
  }

  if (amount > student.balance - student.reserved) {
    return sendJson(res, 409, {
      error: "Công nợ còn lại đã được dành cho giao dịch đang xử lý.",
      paymentId: null,
      status: "FAILED",
    });
  }

  const payment = {
    paymentId: `P${nextPaymentNumber++}`,
    studentId,
    amount,
    status: "PENDING",
    httpStatus: 504,
  };
  payments.set(payment.paymentId, payment);
  if (clientKey) {
    paymentsByClientKey.set(clientKey, payment.paymentId);
  }
  student.reserved += amount;

  const bankResult = await chargeBank(payment);
  if (bankResult.kind === "response" && bankResult.statusCode < 300) {
    payment.status = "PAID";
    payment.httpStatus = 201;
    payment.charge = bankResult.body;
    student.balance -= amount;
    student.reserved -= amount;
    return sendStoredPayment(res, payment);
  }

  if (bankResult.kind === "response") {
    payment.status = "FAILED";
    payment.httpStatus =
      bankResult.statusCode >= 400 && bankResult.statusCode <= 599
        ? bankResult.statusCode
        : 502;
    payment.error =
      bankResult.body.error || "Ngân hàng từ chối giao dịch.";
    student.reserved -= amount;
    return sendStoredPayment(res, payment);
  }

  if (bankResult.kind === "unavailable") {
    payment.status = "FAILED";
    payment.httpStatus = 503;
    payment.error = `Không kết nối được ngân hàng: ${bankResult.error}`;
    student.reserved -= amount;
    return sendStoredPayment(res, payment);
  }

  payment.status = "PENDING";
  payment.httpStatus = 504;
  payment.error = bankResult.error;
  return sendStoredPayment(res, payment);
};

const app = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const feeMatch = requestUrl.pathname.match(/^\/students\/([^/]+)\/fees$/);
    const paymentMatch = requestUrl.pathname.match(
      /^\/students\/([^/]+)\/payments$/,
    );

    if (req.method === "GET" && feeMatch) {
      const studentId = decodeURIComponent(feeMatch[1]);
      const student = students.get(studentId);
      if (!student) {
        return sendJson(res, 404, { error: "Không tìm thấy sinh viên." });
      }
      return sendJson(res, 200, {
        studentId,
        balance: student.balance,
        reservedAmount: student.reserved,
        availableBalance: student.balance - student.reserved,
      });
    }

    if (req.method === "POST" && paymentMatch) {
      const studentId = decodeURIComponent(paymentMatch[1]);
      return await handlePayment(req, res, studentId);
    }

    return sendJson(res, 404, { error: "Không tìm thấy endpoint." });
  } catch (error) {
    console.error("Lỗi xử lý yêu cầu Fee Service:", error);
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || "Lỗi nội bộ Fee Service.",
        paymentId: null,
        status: "FAILED",
      });
    } else {
      res.destroy(error);
    }
  }
});

app.keepAliveTimeout = 5_000;
app.listen(PORT, () => {
  console.log(`Fee Service đang chạy tại http://localhost:${PORT}`);
  console.log(`Bank Service được cấu hình tại ${bankUrl.origin}`);
});
