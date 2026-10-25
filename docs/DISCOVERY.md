# CLS PDF discovery

Ghi lại những gì extension đang dùng khi nói chuyện với HIS. Không còn script `yarn login` / `yarn probe`.

## Host

| Hằng số | URL | Vai trò |
|---|---|---|
| `APP_HOST` | `http://172.16.16.17:2382` | Đăng nhập, `localStorage.auth`, tab preview |
| `HIS_HOST` | `http://172.16.16.17:2301` | API CLS, API chữ ký, file PDF đã ký |
| `PDF_HOST` | `http://172.16.16.17:2201` | PDF gốc của phiếu CLS |

## API

- CLS: `GET {HIS_HOST}/api/file/v1/nb-ket-qua-cls?maHoSo&page=0&sort=createdAt,desc&phieuMoiNhat=true&manHinhHienThi=20&size=999`
- Giấy đã ký: `GET {HIS_HOST}/api/signer/v1/ky?maHoSo&page=0&size=9999&sort=id,desc&phieuMoiNhat=true`
- File đã ký: `{HIS_HOST}/api/signer/v1/files/{fileSauKy}` (bỏ qua nếu không phải `.pdf`)
- Preview: `{APP_HOST}/app/preview-files/{maHoSo}?files={descriptors nối bằng \|\|}`

## Descriptor

- `XN01`: `xnlis<>EMR_BA074.1<>[soPhieu]<>1` — thiếu `soPhieu` thì bỏ phiếu
- Phiếu khác: `cls<>[maBieuMau]<>[id]` — thiếu `maBieuMau` hoặc `id` thì bỏ phiếu

PDF gốc lấy từ `api` / `duongDan` / `fileUrl` / `url` / `ketQua` trên item, ghép vào `PDF_HOST` nếu là path tương đối.

## Cờ dev

`PREVIEW_ONLY` trong `src/config/env.ts` (mặc định `false`). Bật `true` thì chỉ mở tab preview và log URL, không lưu PDF.
