const { setTimeout: delay } = require("node:timers/promises");

const FEE_URL = process.env.FEE_URL || "http://localhost:4001";
const BANK_URL = process.env.BANK_URL || "http://localhost:4002";
const RUN_ID = `${Date.now()}`;

const requestJson = async (url, options = {}) => {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return {
      status: response.status,
      body,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: null,
      error: error.message,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  }
};

const getBankStats = () => requestJson(`${BANK_URL}/stats`);
const getFees = (studentId = 1) =>
  requestJson(`${FEE_URL}/students/${studentId}/fees`);

const postPayment = (studentId, amount, key) =>
  requestJson(`${FEE_URL}/students/${studentId}/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({ amount }),
  });

const tallyStatuses = (results) =>
  results.reduce((counts, result) => {
    const label = result.status === null ? "NETWORK_ERROR" : String(result.status);
    counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {});

const runConcurrent = async (items, concurrency, action) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await action(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const printResult = (scenario, data, checks) => {
  const output = {
    scenario,
    checks: checks.map(({ name, passed, detail }) => ({
      name,
      passed,
      detail,
    })),
    results: data,
  };
  console.log(JSON.stringify(output, null, 2));
  if (checks.some((check) => !check.passed)) {
    process.exitCode = 1;
  }
};

const runBankApi = async () => {
  const before = await getBankStats();
  const health = await requestJson(`${BANK_URL}/`);
  const zero = await requestJson(`${BANK_URL}/charges`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `bank-zero-${RUN_ID}`,
    },
    body: JSON.stringify({ reference: `bank-zero-${RUN_ID}`, amount: 0 }),
  });
  const overLimit = await requestJson(`${BANK_URL}/charges`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `bank-limit-${RUN_ID}`,
    },
    body: JSON.stringify({ reference: `bank-limit-${RUN_ID}`, amount: 25_000_000 }),
  });
  const key = `bank-valid-${RUN_ID}`;
  const first = await requestJson(`${BANK_URL}/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ reference: key, amount: 1_000 }),
  });
  const retry = await requestJson(`${BANK_URL}/charges`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ reference: key, amount: 1_000 }),
  });
  const after = await getBankStats();
  const chargesAdded =
    after.body.charges !== undefined && before.body.charges !== undefined
      ? after.body.charges - before.body.charges
      : null;

  printResult(
    "bank-api",
    { before, health, zero, overLimit, first, retry, after, chargesAdded },
    [
      { name: "Bank Service trả lời GET /", passed: health.status === 200 },
      { name: "Số tiền 0 bị từ chối HTTP 400", passed: zero.status === 400 },
      { name: "Vượt hạn mức bị từ chối HTTP 402", passed: overLimit.status === 402 },
      {
        name: "Giao dịch hợp lệ tạo charge HTTP 201",
        passed: first.status === 201 && Boolean(first.body.chargeId),
      },
      {
        name: "Retry dùng lại charge và không tăng charges",
        passed:
          retry.status === 201 &&
          retry.body.chargeId === first.body.chargeId &&
          chargesAdded === 1,
      },
      {
        name: "Bộ đếm duplicates không tăng do retry",
        passed:
          before.body.duplicates !== undefined &&
          after.body.duplicates === before.body.duplicates,
      },
    ],
  );
};

const runFeeBasics = async () => {
  const initial = await Promise.all([1, 2, 3].map((id) => getFees(id)));
  const beforeBank = await getBankStats();
  const key = `fee-idem-${RUN_ID}`;
  const payment = await postPayment(1, 1_000, key);
  const retry = await postPayment(1, 1_000, key);
  const final = await getFees(1);
  const afterBank = await getBankStats();

  printResult(
    "fee-basics",
    { initial, payment, retry, final, beforeBank, afterBank },
    [
      {
        name: "Công nợ ban đầu của sinh viên 1 là 50.000.000",
        passed: initial[0].status === 200 && initial[0].body.balance === 50_000_000,
      },
      {
        name: "Công nợ ban đầu của sinh viên 2 là 0",
        passed: initial[1].status === 200 && initial[1].body.balance === 0,
      },
      {
        name: "Công nợ ban đầu của sinh viên 3 là 3.200.000",
        passed: initial[2].status === 200 && initial[2].body.balance === 3_200_000,
      },
      {
        name: "Thanh toán hợp lệ trả HTTP 201 và PAID",
        passed: payment.status === 201 && payment.body.status === "PAID",
      },
      {
        name: "Retry Fee Service trả lại cùng paymentId",
        passed:
          retry.status === 201 &&
          retry.body.paymentId === payment.body.paymentId &&
          final.body.balance === 49_999_000,
      },
      {
        name: "Một lần thanh toán chỉ tạo một charge ở ngân hàng",
        passed:
          afterBank.body.charges - beforeBank.body.charges === 1 &&
          afterBank.body.duplicates === beforeBank.body.duplicates,
      },
    ],
  );
};

const runFeeValidation = async () => {
  const unknownStudent = await postPayment(999, 1_000, `unknown-${RUN_ID}`);
  const zeroAmount = await postPayment(1, 0, `zero-${RUN_ID}`);
  const exceedsBalance = await postPayment(3, 3_200_001, `overdue-${RUN_ID}`);
  const missingStudentFees = await getFees(999);
  const errors = [unknownStudent, zeroAmount, exceedsBalance];

  printResult(
    "fee-validation",
    { unknownStudent, zeroAmount, exceedsBalance, missingStudentFees },
    [
      {
        name: "Sinh viên không tồn tại trả 404",
        passed: unknownStudent.status === 404,
      },
      {
        name: "Số tiền 0 và vượt công nợ bị từ chối HTTP 400",
        passed: zeroAmount.status === 400 && exceedsBalance.status === 400,
      },
      {
        name: "Lỗi thanh toán có đủ error, paymentId và status",
        passed: errors.every(
          (result) =>
            typeof result.body.error === "string" &&
            Object.hasOwn(result.body, "paymentId") &&
            typeof result.body.status === "string",
        ),
      },
      {
        name: "GET sinh viên không tồn tại trả 404",
        passed: missingStudentFees.status === 404,
      },
    ],
  );
};

const runBankRejection = async () => {
  const beforeFees = await getFees(1);
  const beforeStats = await getBankStats();
  const payment = await postPayment(1, 25_000_000, `bank-reject-${RUN_ID}`);
  const afterFees = await getFees(1);
  const afterStats = await getBankStats();

  printResult(
    "bank-rejection",
    { beforeFees, payment, afterFees, beforeStats, afterStats },
    [
      {
        name: "HTTP 402 của Bank được giữ nguyên và status là FAILED",
        passed: payment.status === 402 && payment.body.status === "FAILED",
      },
      {
        name: "Lỗi có error, paymentId và status",
        passed:
          typeof payment.body.error === "string" &&
          Boolean(payment.body.paymentId) &&
          payment.body.status === "FAILED",
      },
      {
        name: "Từ chối không làm giảm công nợ hoặc tạo charge",
        passed:
          afterFees.body.balance === beforeFees.body.balance &&
          afterStats.body.charges === beforeStats.body.charges,
      },
    ],
  );
};

const runFeeConcurrency = async () => {
  const beforeFees = await getFees(3);
  const beforeStats = await getBankStats();
  const results = await runConcurrent(
    Array.from({ length: 4 }, (_, index) => index),
    4,
    (index) => postPayment(3, 1_000_000, `debt-race-${RUN_ID}-${index}`),
  );
  const afterFees = await getFees(3);
  const afterStats = await getBankStats();
  const paidCount = results.filter(
    (result) => result.status === 201 && result.body.status === "PAID",
  ).length;

  printResult(
    "fee-concurrency",
    {
      beforeFees,
      afterFees,
      beforeStats,
      afterStats,
      statusCounts: tallyStatuses(results),
      paidCount,
    },
    [
      {
        name: "Công nợ không âm sau bốn yêu cầu đồng thời",
        passed: afterFees.body.balance >= 0,
      },
      {
        name: "Công nợ chỉ giảm theo số giao dịch PAID",
        passed:
          afterFees.body.balance === beforeFees.body.balance - paidCount * 1_000_000,
      },
      {
        name: "Không ghi nhận khoản trừ trùng ở Bank",
        passed:
          afterStats.body.charges - beforeStats.body.charges === paidCount &&
          afterStats.body.duplicates === beforeStats.body.duplicates,
      },
    ],
  );
};

const runOffline = async () => {
  const before = await getFees(1);
  const payment = await postPayment(1, 1_000, `offline-${RUN_ID}`);
  const after = await getFees(1);
  printResult("offline-bank", { before, payment, after }, [
    {
      name: "Ngân hàng không sẵn có trả HTTP 503 FAILED nhanh",
      passed:
        payment.status === 503 &&
        payment.body.status === "FAILED" &&
        payment.elapsedMs < 1_500,
    },
    {
      name: "GET công nợ vẫn hoạt động và không giảm",
      passed: after.status === 200 && after.body.balance === before.body.balance,
    },
  ]);
};

const runRecovery = async () => {
  const beforeFees = await getFees(1);
  const beforeStats = await getBankStats();
  const payment = await postPayment(1, 1_000, `recovery-${RUN_ID}`);
  const afterFees = await getFees(1);
  const afterStats = await getBankStats();

  printResult(
    "bank-recovery",
    { beforeFees, payment, afterFees, beforeStats, afterStats },
    [
      {
        name: "Fee Service thanh toán thành công sau khi Bank hoạt động lại",
        passed: payment.status === 201 && payment.body.status === "PAID",
      },
      {
        name: "Công nợ giảm đúng một lần và Bank tạo một charge",
        passed:
          afterFees.body.balance === beforeFees.body.balance - 1_000 &&
          afterStats.body.charges - beforeStats.body.charges === 1,
      },
    ],
  );
};

const runSlowBank = async () => {
  const beforeStats = await getBankStats();
  const beforeFees = await getFees(1);
  const tasks = Array.from({ length: 20 }, (_, index) => index);
  const paymentsInFlight = tasks.map((index) =>
    postPayment(1, 1_000, `slow-${RUN_ID}-${index}`),
  );
  await delay(100);
  const read = await getFees(1);
  const results = await Promise.all(paymentsInFlight);
  const responseTimes = results.map((result) => result.elapsedMs);
  const maxResponseMs = Math.max(...responseTimes);
  await delay(1_000);
  const afterStats = await getBankStats();
  const afterFees = await getFees(1);

  printResult(
    "slow-bank",
    {
      beforeStats,
      afterStats,
      beforeFees,
      afterFees,
      readDuringPayments: read,
      statuses: tallyStatuses(results),
      maxResponseMs,
      results,
    },
    [
      {
        name: "Thanh toán timeout thành HTTP 504 PENDING trong tối đa 4,5 giây",
        passed:
          results.length === 20 &&
          results.every(
            (result) =>
              result.status === 504 && result.body.status === "PENDING",
          ) &&
          maxResponseMs <= 4_700,
      },
      {
        name: "GET công nợ không bị chặn và không giảm khi PENDING",
        passed:
          read.status === 200 &&
          read.elapsedMs < 300 &&
          afterFees.body.balance === beforeFees.body.balance,
      },
      {
        name: "Ngân hàng lưu các giao dịch đã nhận dù Fee trả PENDING",
        passed: afterStats.body.charges - beforeStats.body.charges === 20,
      },
    ],
  );
};

const runLoad = async () => {
  const beforeStats = await getBankStats();
  const beforeFees = await getFees(1);
  const results = await runConcurrent(
    Array.from({ length: 200 }, (_, index) => index),
    10,
    (index) => postPayment(1, 1_000, `load-${RUN_ID}-${index}`),
  );
  const idleBefore = await getBankStats();
  await delay(6_000);
  const afterIdlePayment = await postPayment(1, 1_000, `load-idle-${RUN_ID}`);
  const afterFees = await getFees(1);
  const afterStats = await getBankStats();
  const paidCount = results.filter(
    (result) => result.status === 201 && result.body.status === "PAID",
  ).length;
  const chargesAdded = afterStats.body.charges - beforeStats.body.charges;
  const connectionsAdded =
    afterStats.body.connections - beforeStats.body.connections;

  printResult(
    "load-200",
    {
      beforeStats,
      idleBefore,
      afterStats,
      beforeFees,
      afterFees,
      statusCounts: tallyStatuses(results),
      paidCount,
      chargesAdded,
      connectionsAdded,
      afterIdlePayment,
    },
    [
      {
        name: "200 thanh toán trả thành công HTTP 201",
        passed: paidCount === 200,
      },
      {
        name: "Tổng số charge tăng đúng 201, gồm request sau 6 giây",
        passed: chargesAdded === 201 && afterIdlePayment.status === 201,
      },
      {
        name: "TCP mới không vượt 20 trong toàn bộ lượt đo",
        passed: connectionsAdded <= 20,
      },
      {
        name: "Công nợ giảm đúng 201.000 đồng",
        passed:
          beforeFees.status === 200 &&
          afterFees.body.balance === beforeFees.body.balance - 201_000,
      },
      {
        name: "Không ghi nhận charge bị trừ trùng",
        passed: afterStats.body.duplicates === beforeStats.body.duplicates,
      },
    ],
  );
};

const runProbabilistic = async (scenario) => {
  const beforeStats = await getBankStats();
  const beforeFees = await getFees(1);
  const results = await runConcurrent(
    Array.from({ length: 60 }, (_, index) => index),
    10,
    (index) => postPayment(1, 1_000, `${scenario}-${RUN_ID}-${index}`),
  );
  const afterFees = await getFees(1);
  const afterStats = await getBankStats();
  const paidCount = results.filter(
    (result) => result.status === 201 && result.body.status === "PAID",
  ).length;
  const pendingCount = results.filter(
    (result) => result.status === 504 && result.body.status === "PENDING",
  ).length;
  const failedCount = results.filter(
    (result) => result.body.status === "FAILED",
  ).length;
  const reportData = {
    beforeStats,
    afterStats,
    beforeFees,
    afterFees,
    statusCounts: tallyStatuses(results),
    paidCount,
    failedCount,
    pendingCount,
    chargesAdded: afterStats.body.charges - beforeStats.body.charges,
    duplicatesAdded: afterStats.body.duplicates - beforeStats.body.duplicates,
  };

  printResult(
    `${scenario}-60`,
    reportData,
    [
      {
        name: "60 yêu cầu đã nhận kết quả",
        passed: results.length === 60,
      },
      {
        name: "Không có khoản trừ trùng",
        passed: reportData.duplicatesAdded === 0,
      },
      {
        name: "Công nợ chỉ giảm theo trạng thái PAID",
        passed:
          beforeFees.status === 200 &&
          afterFees.body.balance === beforeFees.body.balance - paidCount * 1_000,
      },
      {
        name: "Đạt ngưỡng tham khảo 54/60 HTTP 201",
        passed: paidCount >= 54,
        detail:
          "Đây là phép thử xác suất; nếu không đạt, ghi nhận đúng số đo và không giả lập thành công.",
      },
      ...(scenario === "drop"
        ? [
            {
              name: "Giao dịch mất phản hồi được giữ PENDING và charge vẫn lưu ở bank",
              passed:
                pendingCount === 60 - paidCount &&
                reportData.chargesAdded === 60,
            },
          ]
        : [
            {
              name: "Lỗi 500 tường minh không tạo charge ở bank",
              passed:
                reportData.chargesAdded === paidCount &&
                failedCount === 60 - paidCount,
            },
          ]),
    ],
  );
};

const scenarios = {
  "bank-api": runBankApi,
  "fee-basics": runFeeBasics,
  "fee-validation": runFeeValidation,
  "bank-rejection": runBankRejection,
  "fee-concurrency": runFeeConcurrency,
  "offline-bank": runOffline,
  "bank-recovery": runRecovery,
  "slow-bank": runSlowBank,
  "load-200": runLoad,
  "drop-60": () => runProbabilistic("drop"),
  "fail-60": () => runProbabilistic("fail"),
};

const scenario = process.argv[2];
if (!scenario || !scenarios[scenario]) {
  console.error(
    `Cách dùng: node tests/lab3-tests.js <${Object.keys(scenarios).join("|")}>`,
  );
  process.exit(2);
} else {
  scenarios[scenario]().catch((error) => {
    console.error("Không thể hoàn thành kịch bản kiểm thử:", error);
    process.exitCode = 1;
  });
}
