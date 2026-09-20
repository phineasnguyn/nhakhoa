# Triển khai tối ưu lưu trữ ảnh

## Tổng quan

Tính năng chuyển chế độ processed từ một bitmap thứ hai sang ảnh RAW cộng metadata overlay. Backend và Python xử lý hình học; frontend dựng bounding box bằng SVG. Luồng mới không upload ảnh processed, không tạo ZIP trung gian và không sinh prediction ngẫu nhiên.

Nền BullMQ và luồng xóa bệnh nhân đã có trên nhánh dev. Tính năng này chỉ mở rộng pipeline xử lý ảnh; không sao chép lại các thành phần đã tồn tại trên dev.

## Thành phần triển khai

### Schema

Migration 011 bổ sung:

- image_revision và annotation_revision;
- processed_image_revision và overlay_schema_version;
- overlay_review_reason;
- annotations_verified_empty;
- legacy_image_revision;
- bảng image_source_history;
- trigger invalidation khi nguồn ảnh hoặc hình học annotation thay đổi.

Các trường mới có giá trị mặc định tương thích dữ liệu cũ. url_processed vẫn được giữ để fallback trong giai đoạn chuyển đổi. Khi hình học annotation thay đổi, legacy_image_revision được đặt về 0 để loại bitmap cũ khỏi hiển thị; URL và object vẫn được giữ cho rollback. Chỉ đổi nhãn không vô hiệu hóa hình học. Migration 011 có thể chạy lại để cập nhật trigger.

### Geometry service

Endpoint /api/process/overlay-metadata nhận JSON gồm kích thước ảnh, parent annotation ID và bbox răng/mắc cài.

Kết quả gồm bốn vùng top, bottom, left, right theo parent ID. Endpoint từ chối:

- kích thước hoặc bbox không hợp lệ;
- thiếu mắc cài;
- nhiều mắc cài cùng khớp một răng;
- vùng có diện tích bằng không hoặc vượt biên.

Endpoint không đọc hoặc ghi file ảnh.

### Backend processing

imageOverlayService đọc ảnh và annotations trong snapshot nhất quán. Nếu metadata kích thước chưa có, service đọc kích thước từ object nguồn rồi cập nhật bằng compare-and-set.

Trước khi ghi kết quả, service khóa patient, visit và image theo cùng thứ tự với luồng xóa bệnh nhân, sau đó kiểm tra lại image revision và annotation revision.

Nhóm subbox hợp lệ đã tồn tại được giữ nguyên. Ngoài kiểm tra parent, biên ảnh và bốn tên vùng khác nhau, service từ chối subbox trùng hoặc chồng diện tích; các vùng được phép chung cạnh. Quy tắc này áp dụng cả vùng có sẵn, kết quả geometry service và overlay đã được đánh dấu hoàn tất. Service chỉ tạo bốn vùng cho parent còn thiếu và đặt trạng thái review khi dữ liệu không đủ rõ ràng.

### BullMQ

Job Redis sử dụng ID dạng image-<processing job id> để liên kết lại bản ghi PostgreSQL. Payload chỉ giữ visit ID và user ID; không chứa bitmap hoặc toàn bộ annotations.

Worker ghi tiến độ theo từng ảnh và trả các trạng thái:

- completed;
- partial;
- review_required;
- failed.

Retry đang chờ được trả là queued để frontend không kết luận thất bại sớm. Reconciler khôi phục job bị gián đoạn giữa bước ghi PostgreSQL và enqueue, đồng thời đồng bộ trạng thái job hoàn tất.

### API và frontend

API trình bày rõ render_mode: raw, legacy_bitmap hoặc overlay. Ảnh legacy có subbox vẫn được sửa nhãn trên ảnh nguồn cùng lớp SVG; không cần tạo bitmap mới hoặc chuyển trạng thái thành overlay-ready. Nếu không có subbox, frontend tiếp tục hiển thị bitmap legacy. Lightbox tải snapshot hiện tại trước khi chọn cách hiển thị để tránh dùng lại bitmap vừa bị vô hiệu hóa.

Frontend chuẩn hóa URL ảnh qua proxy và dùng revision làm version cache. Chế độ overlay dùng thẻ IMG làm bitmap nền và SVG làm lớp vector. Grid và lightbox dùng cùng URL nguồn; hover hoặc sửa nhãn chỉ cập nhật vector.

Polling theo đúng job ID, có timeout và hủy khi component unmount. Kết quả partial/review được hiển thị thay vì báo thành công cho toàn visit.

### Proxy ảnh

Proxy gọi stat trước khi mở stream, trả ETag, Content-Length và Content-Type. Request có ETag phù hợp nhận 304 mà không đọc body object. Stream sử dụng pipeline để xử lý backpressure và client disconnect.

### Xoay ảnh

Backend luôn xoay object nguồn hiện tại. Client chỉ gửi góc xoay và revision mong đợi.

Trong transaction, service:

- kiểm tra lại revision;
- lưu snapshot nguồn và annotations;
- cập nhật URL, width và height;
- transform mọi bbox;
- hoán đổi tên vùng canonical;
- giữ annotation ID, nhãn và lịch sử.

Object mới dùng key riêng. Nếu transaction chưa commit, object mới có thể được dọn; nếu kết quả COMMIT không chắc chắn, object được giữ để tránh xóa nhầm nguồn đang hoạt động.

### Export và cleanup

Dataset export tiếp tục lấy ảnh nguồn sạch cùng bbox hiện tại. Mapping nhãn số 0/1 được giữ và object key được chuẩn hóa qua storage service.

Storage deletion kế thừa kiểm tra thêm image_source_history để không xóa object còn dùng làm nguồn rollback.

Công cụ audit-image-storage chỉ tạo manifest review. Công cụ không có chế độ apply và không xóa dữ liệu.

## Triển khai

Thứ tự khuyến nghị:

1. backup PostgreSQL và bucket;
2. áp dụng migration 011 sau các migration của dev;
3. triển khai geometry service;
4. triển khai backend worker/API;
5. triển khai frontend;
6. chuyển đổi một nhóm ảnh nhỏ và review trực quan;
7. mở rộng chuyển đổi theo từng nhóm;
8. tạo manifest audit sau thời gian giữ rollback.

Bitmap legacy chỉ được thu hồi trong một quy trình vận hành riêng sau khi kiểm tra consumer, revision, ETag, soft-delete, history và bucket versioning.

## Rollback

Ứng dụng mới vẫn đọc được legacy bitmap. Khi cần rollback trước cleanup, có thể chuyển traffic về phiên bản tương thích legacy mà không khôi phục object.

Sau khi đã xóa bitmap legacy, rollback về phiên bản rất cũ có thể cần dựng lại bitmap từ ảnh nguồn và metadata. Vì vậy cleanup phải tách khỏi deployment và chỉ thực hiện sau khi thời gian rollback kết thúc.
