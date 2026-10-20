# Kiểm thử Lab 3

Các script dùng `fetch` có sẵn trong Node.js 18 trở lên; không cần cài thêm package. Chạy các lệnh từ thư mục gốc `lab3-payment-system` trong PowerShell.

## Khởi động service

Mở một cửa sổ PowerShell riêng cho mỗi service:

```powershell
Set-Location 'C:\Users\Admin\Documents\Typescript\lab3-payment-system\bank-service'
npm start
```

```powershell
Set-Location 'C:\Users\Admin\Documents\Typescript\lab3-payment-system\fee-service'
npm start
```

Không chạy bản thứ hai nếu cửa sổ khác đã dùng cùng cổng. Dừng service bằng `Ctrl + C`.

## Chạy kịch bản

```powershell
Set-Location 'C:\Users\Admin\Documents\Typescript\lab3-payment-system'
node .\tests\lab3-tests.js bank-api
```

Thay `bank-api` bằng một kịch bản dưới đây; mỗi lần chỉ chạy một kịch bản:

| Kịch bản | Service cần chạy | Cấu hình/ghi chú |
|---|---|---|
| `bank-api` | Bank | API bank, validation và idempotency cơ bản; đặt các biến mô phỏng về 0 |
| `fee-basics` | Bank và Fee | Công nợ ban đầu, thanh toán và idempotency |
| `fee-validation` | Fee | Sinh viên không tồn tại, số tiền sai và hình dạng JSON lỗi |
| `bank-rejection` | Bank và Fee | Bank từ chối HTTP 402; công nợ không giảm |
| `fee-concurrency` | Bank và Fee | Bốn thanh toán đồng thời không được vượt công nợ sinh viên 3 |
| `offline-bank` | Chỉ Fee | Dừng Bank trước khi chạy; kiểm tra Fee vẫn phục vụ GET và trả 503 cho thanh toán |
| `bank-recovery` | Bank và Fee | Chạy sau khi bật lại Bank, không khởi động lại Fee |
| `slow-bank` | Bank và Fee | Khởi động Bank với `$env:DELAY_MS='5000'`; yêu cầu chờ khoảng 4,5 giây |
| `load-200` | Bank và Fee | Chạy khi `DELAY_MS`, `FAIL_RATE`, `DROP_RATE` đều bằng 0; gồm thời gian chờ nhàn rỗi 6 giây |
| `drop-60` | Bank và Fee | Khởi động Bank với `$env:DROP_RATE='0.3'` và `FAIL_RATE='0'` |
| `fail-60` | Bank và Fee | Khởi động Bank với `$env:FAIL_RATE='0.3'` và `DROP_RATE='0'` |

Để chạy Bank với cấu hình bình thường, đặt các biến rồi khởi động trong cùng cửa sổ PowerShell:

```powershell
$env:DELAY_MS = '0'
$env:FAIL_RATE = '0'
$env:DROP_RATE = '0'
Set-Location 'C:\Users\Admin\Documents\Typescript\lab3-payment-system\bank-service'
npm start
```

Ví dụ cấu hình chậm: thay `DELAY_MS` bằng `'5000'`. Để khởi động lại ở cấu hình thường, dừng Bank bằng `Ctrl + C`, đặt các biến về `'0'`, rồi chạy `npm start` lại. Dùng `$env:VARIABLE = $null` nếu muốn xóa hẳn biến khỏi cửa sổ PowerShell.

Để kiểm tra `BANK_URL` trỏ tới địa chỉ không đúng, dừng Fee bằng `Ctrl + C`, đặt `$env:BANK_URL = 'http://localhost:4999'`, rồi chạy `npm start` lại trong cùng cửa sổ Fee. Chạy `offline-bank` từ thư mục gốc để xác nhận Fee vẫn phục vụ GET và báo 503 cho thanh toán. Sau đó dừng Fee, đặt `$env:BANK_URL = 'http://localhost:4002'`, khởi động lại Fee; nếu Bank đang hoạt động, chạy `bank-recovery`. Không cần khởi động lại Fee khi chỉ bật lại Bank.

`drop-60` và `fail-60` là phép thử xác suất; kết quả thực tế có thể khác kỳ vọng. Yêu cầu “ít nhất 54/60 HTTP 201” không thể được đảm bảo khi tỷ lệ lỗi là 0,3 và không retry giao dịch chưa rõ kết quả. Script ghi số đo thật, đánh dấu ngưỡng không đạt nếu có, và không sửa kết quả.

Service lưu dữ liệu trong bộ nhớ. Để làm lại phép thử với trạng thái sạch, dừng cả hai service bằng `Ctrl + C` rồi khởi động lại. Việc này chỉ xóa dữ liệu tạm trong bộ nhớ; không xóa file dự án.

Kịch bản tải dùng sinh viên 1 và trừ 1.000 đồng cho mỗi lần thanh toán, vì vậy hãy bắt đầu nó từ trạng thái sạch để so sánh công nợ và số charge chính xác.
