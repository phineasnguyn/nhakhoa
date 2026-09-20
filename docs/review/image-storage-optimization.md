# Review: tối ưu lưu trữ ảnh

## Phạm vi

Feature thay bitmap processed bằng ảnh nguồn cùng metadata overlay, đồng thời giữ khả năng đọc ảnh legacy. Đợt sửa hiện tại tập trung vào các vấn đề 1, 2 và 4; các vấn đề 3 và 5 vẫn chưa được xử lý.

Tài liệu liên quan:

- [Kế hoạch tối ưu lưu trữ và cache](../image-storage-cache-review-plan.md)
- [Thiết kế và triển khai](../image-storage-optimization-implementation.md)

## Các phát hiện và trạng thái

| ID | Vấn đề | Trạng thái | Phạm vi liên quan |
| --- | --- | --- | --- |
| 1 | Ảnh legacy mất khả năng sửa nhãn | Đã sửa | Tương thích frontend legacy/overlay |
| 2 | Thay đổi hình học annotation nhưng vẫn hiển thị bitmap legacy cũ | Đã sửa | Revision và điều kiện fallback |
| 3 | Nhãn mặc định có thể được export như nhãn đã xác nhận | Chưa xử lý | Hành vi kế thừa từ luồng tạo nhãn/export |
| 4 | Subbox trùng hoặc chồng diện tích vẫn được chấp nhận | Đã sửa | Kiểm tra hình học trước khi chấp nhận overlay |
| 5 | Reconciler giữ khóa PostgreSQL trong lúc chờ Redis | Chưa xử lý | Phục hồi job khi Redis gián đoạn |

## 1. Khôi phục sửa nhãn trên ảnh legacy

Frontend dùng ảnh nguồn cùng lớp SVG khi ảnh legacy có metadata subbox. Người dùng tiếp tục sửa nhãn theo annotation ID hiện có mà không phải tạo thêm bitmap hoặc đánh dấu ảnh thành overlay-ready.

Grid và lightbox cùng áp dụng quy tắc chọn ảnh nền. Lightbox tải snapshot ảnh và annotations hiện tại trước khi chọn cách hiển thị, tránh dùng trạng thái cũ từ grid. Nếu không có subbox, ảnh legacy vẫn được hiển thị bằng bitmap processed. Nếu tải annotations thất bại, lightbox báo lỗi thay vì cho sửa trên khung cũ.

Thành phần:

- [ProcessedImageViewer](../../frontend/src/features/images/components/ProcessedImageViewer.jsx)
- [Quy tắc trình bày ảnh phía frontend](../../frontend/src/services/imagePresentation.js)

## 2. Vô hiệu hóa bitmap legacy khi hình học thay đổi

Trigger đặt `legacy_image_revision = 0` khi annotation được thêm, xóa hoặc thay đổi bbox, parent, ảnh sở hữu, category hay tên vùng. Khi chuyển annotation sang ảnh khác, cả ảnh nguồn và ảnh đích đều bị vô hiệu hóa bitmap legacy.

API chuyển về `raw` nếu không còn kết quả hợp lệ. URL và object legacy vẫn được giữ để phục vụ rollback; không có thao tác xóa MinIO trong bước này. Thay đổi nhãn hoặc thông tin người gán nhãn đơn thuần vẫn tăng annotation revision nhưng không vô hiệu hóa hình học.

Thành phần: [Migration 011](../../init-db/011_add_image_overlay_metadata.sql).

## 4. Kiểm tra subbox trùng và chồng diện tích

Ngoài số lượng vùng, tên vùng, quan hệ parent và biên bbox, service kiểm tra từng cặp subbox trong cùng một parent:

- từ chối bbox trùng nhau;
- từ chối phần giao có diện tích, với dung sai nhỏ cho sai số số thực;
- cho phép các vùng chung cạnh;
- giữ nguyên tên vùng legacy, ID và nhãn của nhóm hợp lệ.

Quy tắc áp dụng cho metadata có sẵn và kết quả mới từ geometry service. Khi xử lý lại, overlay đã được đánh dấu hoàn tất cũng được kiểm tra. Nếu dữ liệu không hợp lệ, service đưa kết quả về diện cần review, không tự sửa hoặc tạo lại annotations.

Việc vô hiệu hóa kết quả đã hoàn tất sử dụng điều kiện so khớp image revision và annotation revision, tránh ghi đè dữ liệu mới hơn do thao tác đồng thời.

Thành phần: [Image overlay service](../../backend/src/services/imageOverlayService.js).

## Tiêu chí chấp nhận của đợt sửa

- Ảnh legacy có subbox sửa được nhãn và giữ lịch sử annotation.
- Ảnh legacy không có subbox vẫn xem được bitmap cũ.
- Snapshot mới không còn hợp lệ thì lightbox không dùng bitmap legacy cũ.
- Chỉ đổi nhãn không đổi URL hoặc revision của ảnh nền.
- Thay đổi hình học vô hiệu hóa fallback legacy nhưng giữ tham chiếu phục vụ rollback.
- Subbox trùng hoặc chồng diện tích bị từ chối; vùng chung cạnh vẫn hợp lệ.
- Xử lý lại nhóm hợp lệ không tạo thêm subbox hoặc thay nhãn.
- Kết quả review từ snapshot cũ không ghi đè overlay đã được cập nhật đồng thời.

## Yêu cầu triển khai

Áp dụng migration 011 đã cập nhật trước khi triển khai backend và frontend tương ứng. Nếu migration 011 đã được áp dụng trước đó, cần chạy lại bản cập nhật để thay thế trigger. Chạy lại migration không khôi phục hiệu lực cho bitmap legacy đã bị vô hiệu hóa.

Các sửa đổi này không xử lý vấn đề 3 và 5. Luồng export vẫn cần phân biệt nhãn mặc định với nhãn đã được xác nhận; reconciler vẫn cần giới hạn thời gian chờ Redis và thời gian giữ khóa DB. Không coi toàn bộ các phát hiện trong review là đã đóng.
