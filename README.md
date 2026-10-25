# XP-AutoBADT

Chrome Extension (Manifest V3) để xuất kết quả cận lâm sàng (CLS/XN) từ HIS/EMR thành PDF tổng hợp theo danh sách mã hồ sơ trong Excel.

## Yêu cầu

- Google Chrome
- Máy trong mạng nội bộ bệnh viện, truy cập được:
  - `http://172.16.16.17:2382` — giao diện HIS (đăng nhập, preview)
  - `http://172.16.16.17:2301` — API CLS và giấy đã ký
  - `http://172.16.16.17:2201` — PDF gốc
- Đã đăng nhập HIS tại `http://172.16.16.17:2382`

## Cài đặt & build

```bash
yarn
yarn dev     # HMR → load unpacked từ dist/
# hoặc
yarn build   # production → dist/
```

1. Mở `chrome://extensions` → bật **Developer mode**
2. **Load unpacked** → chọn thư mục `dist/`
3. Mở tab HIS `http://172.16.16.17:2382` và đăng nhập bình thường
4. Bấm icon extension → Side Panel mở
5. Nhập mã hồ sơ tay **hoặc** upload Excel `.xlsx` / `.xls` (cột **Mã hồ sơ**) → **Xuất PDF**
   - Lần xuất đầu: Chrome hỏi chọn **thư mục lưu** — các file sau ghi thẳng vào đó, không hỏi lại
   - Hồ sơ đã có `[MA_HO_SO].pdf` (dung lượng > 0) trong thư mục sẽ **bỏ qua**, không gọi HIS lại
   - Ô nhập tay: mỗi dòng một mã, hoặc cách nhau bởi `,` / `;`
   - Nếu cả hai đều có dữ liệu, **nhập tay được ưu tiên**
6. **Giữ side panel mở** trong lúc xuất (ghi file diễn ra trên panel)
7. Có thể bấm **Dừng** để hủy ngay (đóng tab preview, bỏ các mã còn lại)

PDF được ghi vào thư mục đã chọn dưới dạng `[MA_HO_SO].pdf`. Chạy lại file Excel đầy đủ chỉ quét mã chưa có PDF; muốn xuất lại một mã thì xóa file PDF đó trước. Kèm file báo cáo `[nguon]-ket-qua.xlsx` (sheet **Ket qua** so sánh API/descriptor/PDF; sheet **Chi tiet van de** liệt kê phiếu bị bỏ hoặc lệch). Nếu còn mã chưa lấy được (cancelled/error), thêm `[nguon]-con-lai.xlsx` để upload chạy lại.

## Cách hoạt động

1. Content script đọc `localStorage.auth` trên tab HIS (`:2382`) và gửi token về background
2. Với mỗi `maHoSo`:
   - Gọi API `nb-ket-qua-cls`, build descriptor (`XN01` → `xnlis<>EMR_BA074.1<>[soPhieu]<>1`, còn lại → `cls<>[maBieuMau]<>[id]`)
   - Gọi API chữ ký `/api/signer/v1/ky` để lấy giấy KSK đã ký (chỉ file `.pdf`; XML và file khác bị bỏ qua)
3. Không có descriptor CLS và không có giấy KSK PDF → `empty`, bỏ qua URL/tab và delay 1.5s, sang mã tiếp
4. Chỉ có giấy KSK: tải PDF đã ký rồi ghép, không mở tab preview
5. Có descriptor CLS: tải PDF gốc từ `:2201` (tối đa 3 phiếu cùng lúc). Thiếu phiếu thì mở tab preview trên `:2382` và bắt PDF mạng; không bắt được thì dùng canvas đã vẽ
6. Giấy KSK PDF được nối sau phần CLS, ghép bằng `pdf-lib`, ghi `[MA_HO_SO].pdf` qua File System Access API
7. Cuối batch: lưu Excel local + (nếu đã cấu hình) POST tóm tắt lên Google Sheet

## Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| HTTP 401/403 (hết phiên) | Refresh token từ tab HIS tối đa 3 lần (chờ 10s, 15s, 20s). Vẫn lỗi thì dừng batch |
| Mất mạng | Thử lại sau 2s rồi 5s. Vẫn lỗi thì ghi lỗi hồ sơ đang chạy và dừng batch |
| Timeout | Ghi lỗi hồ sơ đang chạy, dừng batch ngay |
| Không bắt được PDF preview (không có PDF mạng và không có canvas) | Ghi `error` cho hồ sơ đó, **chạy tiếp** các mã còn lại; mã này vào file còn lại |
| Lỗi khác khi lấy PDF | Ghi lỗi hồ sơ đang chạy, dừng batch |
| Không có CLS và không có giấy KSK PDF | `empty` — chạy mã tiếp, không đưa vào Excel còn lại |
| Bấm **Dừng** | Hủy request/tab; ghi 1 dòng cho mã đang chạy; mở lại nút Xuất PDF |

JWT hết hạn trên token đang lưu không tự dừng batch. Extension chỉ dừng khi không còn token, hoặc API vẫn trả 401/403 sau 3 lần refresh.

Khi còn mã chưa lấy được, thư mục output có thêm `[nguồn]-con-lai.xlsx` (cột **Mã hồ sơ**): mã không bắt được PDF preview, cộng mã vừa lỗi và các mã chưa chạy nếu batch dừng giữa chừng. Upload lại file đó để chạy tiếp; mã đã `success` / `empty` không nằm trong danh sách. Hoặc upload lại file Excel đầy đủ: extension tự bỏ qua mã đã có PDF trong thư mục lưu.

## Google Sheet (theo dõi lần chạy)

Sau mỗi lần xuất, extension ghi tóm tắt lên Google Sheet dùng chung (nếu đã cấu hình webhook). Báo cáo Excel local vẫn lưu như cũ.

1. Tạo Google Sheet với **2 tab** đúng tên: `Lan_chay`, `Chi_tiet_loi`
2. **Extensions → Apps Script** → dán nội dung [`docs/google-sheet-logger.gs`](docs/google-sheet-logger.gs) → Save
3. Trong script, đổi `WEBHOOK_SECRET` thành chuỗi bí mật của bạn
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy URL web app vào [`src/config/env.ts`](src/config/env.ts):

```ts
export const GOOGLE_SHEETS_WEBHOOK_URL = 'https://script.google.com/macros/s/.../exec';
export const GOOGLE_SHEETS_SECRET = 'cùng_giá_trị_WEBHOOK_SECRET';
```

6. `yarn build` / `yarn dev` lại và reload extension

Nếu URL để trống, extension bỏ qua ghi cloud và log: `Chưa cấu hình webhook Google Sheet`.

| Tab | Nội dung |
|---|---|
| `Lan_chay` | 1 dòng / batch: thời gian, người chạy, file nguồn, counts, lý do dừng, phân tích lỗi |
| `Chi_tiet_loi` | Hồ sơ trống, lỗi, dừng giữa chừng, và phiếu thành công nhưng bị bỏ / lệch / dùng canvas. Timeout không ghi vào đây |

Máy bệnh viện cần truy cập được `script.google.com` (mạng ra internet).

## Lưu ý

- Khi dùng fallback capture, Chrome có thể hiện banner debugger tạm thời — extension tự detach sau khi xong.
- Token hết hạn giữa chừng: extension tự refresh từ tab HIS (tối đa 3 lần). Nếu vẫn 401/403 thì đăng nhập lại trên tab HIS rồi chạy file còn lại.
- Đóng side panel giữa lúc xuất có thể làm lỗi bước lưu PDF.
- Hồ sơ `empty` (không CLS, không giấy KSK PDF): bỏ qua mở URL/tab và không chờ delay 1.5s trước mã tiếp theo.
