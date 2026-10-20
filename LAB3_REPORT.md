# Báo cáo Lab 3 — Kết nối và duy trì kết nối giữa các service

> Báo cáo này chỉ ghi nhận kết quả thực thi khi người dùng đã chạy kịch bản và cung cấp đầu ra. Mọi kết quả bên dưới hiện là **CHƯA KIỂM THỬ**.

## 1. Mục tiêu

Tìm hiểu cách Fee Service giao tiếp với Bank Service, giữ kết nối HTTP, xử lý lỗi mạng, timeout và tránh thanh toán/trừ tiền lặp.

## 2. Kiến trúc và luồng thanh toán

```text
Client
  ├── GET /students/:id/fees
  └── POST /students/:id/payments
          Fee Service (:4001)
            ├── giữ công nợ trong bộ nhớ
            ├── dùng HTTP keep-alive và timeout 4.500 ms
            └── POST /charges ──> Bank Service (:4002)
                                  ├── idempotency theo paymentId
                                  ├── mô phỏng DELAY/FAIL/DROP
                                  └── GET /stats
```

Khi thanh toán được Bank xác nhận thành công, Fee Service chuyển trạng thái sang `PAID` và trừ công nợ một lần. Lỗi từ chối rõ ràng hoặc lỗi kết nối chắc chắn chưa gửi được trả `FAILED`; timeout/đứt kết nối không rõ kết quả trả `PENDING` và không giảm công nợ. Fee Service không tự retry giao dịch chưa rõ kết quả.

## 3. Endpoint và cấu hình

| Service | Endpoint/cấu hình |
|---|---|
| Bank | `GET /`, `POST /charges`, `GET /stats`; cổng mặc định 4002 |
| Fee | `GET /students/:id/fees`, `POST /students/:id/payments`; cổng mặc định 4001 |
| Fee → Bank | `BANK_URL`, mặc định `http://localhost:4002` |
| Bank fault injection | `DELAY_MS` không âm; `FAIL_RATE` và `DROP_RATE` trong khoảng 0–1 |
| Fee timeout | 4.500 ms |

Công nợ ban đầu: sinh viên 1 là 50.000.000 đồng; sinh viên 2 là 0 đồng; sinh viên 3 là 3.200.000 đồng.

## 4. Kết nối và idempotency

Fee Service dùng HTTP Agent tích hợp sẵn của Node.js với keep-alive và tối đa 20 socket đang hoạt động. Bank Service đóng kết nối HTTP nhàn rỗi sau 5 giây. Mỗi payment có `paymentId` riêng và gửi `Idempotency-Key` ổn định tới Bank. Có thể gửi thêm `Idempotency-Key` ở request Fee để nhận lại cùng payment, không gửi giao dịch mới.

## 5. Kết quả kiểm thử

| Kịch bản | Kết quả thực tế |
|---|---|
| Bank API, kiểm tra HTTP 400/402 và idempotency | CHƯA KIỂM THỬ |
| Công nợ ban đầu, thanh toán và idempotency ở Fee | CHƯA KIỂM THỬ |
| Bank dừng/hoạt động lại | CHƯA KIỂM THỬ |
| Bank chậm 5 giây, timeout và đọc công nợ song song | CHƯA KIỂM THỬ |
| 200 thanh toán, concurrency 10, reuse kết nối và idle 6 giây | CHƯA KIỂM THỬ |
| `DROP_RATE=0.3`, 60 thanh toán | CHƯA KIỂM THỬ |
| `FAIL_RATE=0.3`, 60 thanh toán | CHƯA KIỂM THỬ |

Chưa có số liệu request, status, thời gian phản hồi, TCP connections, charges, duplicates hoặc công nợ trước/sau nào được ghi nhận. Sẽ điền bằng đầu ra thực tế của các script trong `tests`.

## 6. Giới hạn và lưu ý

- Dữ liệu của cả hai service hiện ở trong bộ nhớ, khởi động lại sẽ đặt lại dữ liệu.
- `PENDING` giữ khoản tiền trong phần `reservedAmount` để tránh cấp lại hạn mức khi chưa biết Bank đã xử lý hay chưa; cần đối soát thủ công trong phạm vi bài lab.
- Với tỷ lệ lỗi 0,3, ngưỡng 54/60 HTTP 201 không được đảm bảo nếu không retry. Retry một giao dịch có kết quả chưa rõ bị cấm để tránh trừ tiền hai lần; cần báo cáo kết quả xác suất thực tế.
- Tất cả phép thử: **CHƯA KIỂM THỬ** cho đến khi có kết quả chạy thật.
