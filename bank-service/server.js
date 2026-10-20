
const express = require("express");

const app = express();

const PORT = Number(process.env.PORT || 4002);
const LIMIT = 20_000_000;

// Lưu giao dịch trong bộ nhớ
const chargesByKey = new Map();
const chargesByReference = new Map();

let requests = 0;
let connections = 0;
let duplicates = 0;

// Các biến mô phỏng lỗi
const readNumberEnv = (name, defaultValue) => {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (rawValue.trim() === "" || !Number.isFinite(value)) {
    console.error(`Biến môi trường ${name} phải là một số hợp lệ.`);
    process.exit(1);
  }

  return value;
};

const DELAY_MS = readNumberEnv("DELAY_MS", 0);
const FAIL_RATE = readNumberEnv("FAIL_RATE", 0);
const DROP_RATE = readNumberEnv("DROP_RATE", 0);

if (DELAY_MS < 0) {
  console.error("Biến môi trường DELAY_MS phải là số không âm.");
  process.exit(1);
}

if (FAIL_RATE < 0 || FAIL_RATE > 1) {
  console.error("Biến môi trường FAIL_RATE phải nằm trong khoảng từ 0 đến 1.");
  process.exit(1);
}

if (DROP_RATE < 0 || DROP_RATE > 1) {
  console.error("Biến môi trường DROP_RATE phải nằm trong khoảng từ 0 đến 1.");
  process.exit(1);
}

// Đếm kết nối TCP mới
const server = require("http").createServer(app);
server.keepAliveTimeout = 5_000;

server.on("connection", (socket) => {
  connections++;
  console.log("Kết nối TCP mới. Tổng:", connections);

  socket.on("close", () => {
    // Socket đã đóng
  });
});

// Middleware đếm HTTP request
app.use((req, res, next) => {
  requests++;
  next();
});

app.use(express.json());

// API kiểm tra trạng thái ngân hàng
app.get("/", (req, res) => {
  res.json({ message: "Bank Service is running" });
});

// API tạo giao dịch trừ tiền
app.post("/charges", async (req, res) => {
  const { reference, amount } = req.body || {};
  const key = req.get("Idempotency-Key")?.trim();
  const normalizedReference =
    typeof reference === "string" ? reference.trim() : "";

  if (!normalizedReference || !key) {
    return res.status(400).json({
      error: "reference và Idempotency-Key là bắt buộc",
    });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: "Số tiền không hợp lệ",
    });
  }

  if (amount > LIMIT) {
    return res.status(402).json({
      error: "Số tiền vượt hạn mức 20.000.000đ",
    });
  }

  const findDuplicate = () => {
    if (chargesByKey.has(key)) {
      return chargesByKey.get(key);
    }

    if (chargesByReference.has(normalizedReference)) {
      const existingCharge = chargesByReference.get(normalizedReference);
      chargesByKey.set(key, existingCharge);
      return existingCharge;
    }

    return null;
  };

  // Cùng khóa hoặc reference: trả kết quả cũ, không tạo giao dịch mới
  const existingCharge = findDuplicate();
  if (existingCharge) {
    duplicates++;
    return res.status(201).json(existingCharge);
  }

  // Giả lập lỗi 500 trước khi trừ tiền
  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({
      error: "Lỗi ngân hàng tạm thời",
    });
  }

  // Giả lập ngân hàng xử lý chậm
  if (DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  // Kiểm tra lại sau thời gian chờ để chặn các request đồng thời bị trùng
  const chargeAfterDelay = findDuplicate();
  if (chargeAfterDelay) {
    duplicates++;
    return res.status(201).json(chargeAfterDelay);
  }

  // Ngân hàng đã trừ tiền thành công
  const charge = {
    chargeId: "CH" + (chargesByReference.size + 1),
    reference: normalizedReference,
    amount,
  };

  chargesByKey.set(key, charge);
  chargesByReference.set(normalizedReference, charge);

  // Giả lập đã trừ tiền nhưng ngắt kết nối trước khi trả lời
  if (Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }

  return res.status(201).json(charge);
});

// API thống kê
app.get("/stats", (req, res) => {
  res.json({
    connections,
    requests,
    charges: chargesByReference.size,
    duplicates,
  });
});

server.listen(PORT, () => {
  console.log(`Bank Service đang chạy tại http://localhost:${PORT}`);
});
