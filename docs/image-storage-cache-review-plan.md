# Kế hoạch tối ưu lưu trữ và hiển thị ảnh

## 1. Bài toán

Luồng cũ lưu ảnh nguồn và ảnh đã vẽ bounding box thành hai object riêng. Phần hiển thị khác nhau chủ yếu là metadata hình học, vì vậy bitmap processed làm tăng dung lượng MinIO và tạo thêm URL/cache cần quản lý.

Mục tiêu của thay đổi:

- dùng một ảnh nguồn cho chế độ RAW và processed;
- lưu bounding box răng, mắc cài và bốn vùng đánh giá dưới dạng metadata;
- hiển thị processed bằng ảnh nguồn cộng lớp overlay;
- giữ nguyên nhãn đã nhập, quan hệ parent và lịch sử chỉnh sửa;
- hỗ trợ ảnh legacy trong thời gian chuyển đổi;
- không đưa bitmap hoặc annotation lớn vào BullMQ/Redis.

Ảnh stained, ảnh augmentation và phiên bản nguồn phát sinh khi thay hoặc xoay ảnh vẫn là nội dung độc lập.

## 2. Kiến trúc mục tiêu

Luồng xử lý ảnh:

1. API tạo job xử lý theo visit trong PostgreSQL rồi enqueue BullMQ.
2. Worker đọc ảnh RAW và annotations hiện tại.
3. Nếu thiếu kích thước, worker đọc metadata của ảnh nguồn một lần.
4. Python nhận JSON gồm kích thước, annotation ID và bbox; endpoint không nhận bitmap.
5. Python trả bốn vùng hình học theo parent annotation ID.
6. Backend kiểm tra revision, bbox và quan hệ parent rồi ghi metadata trong một transaction.
7. Frontend dùng cùng URL ảnh nguồn và dựng overlay SVG theo tọa độ ảnh.

Redis chỉ giữ ID job, tiến độ, trạng thái và kết quả tóm tắt. Bitmap và toàn bộ annotations tiếp tục nằm trong MinIO/PostgreSQL.

## 3. Schema và tính nhất quán

Migration bổ sung:

- revision cho nội dung ảnh và annotations;
- revision ảnh đã dùng để tạo overlay;
- phiên bản schema overlay;
- lý do cần review;
- cờ xác nhận tập annotations rỗng hợp lệ;
- lịch sử nguồn ảnh để hỗ trợ xoay và rollback.

Kết quả chỉ được coi là overlay-ready khi trạng thái hoàn tất, schema hợp lệ và revision kết quả khớp revision ảnh hiện tại.

Trigger tăng revision khi ảnh, kích thước hoặc hình học annotation thay đổi. Worker đối chiếu revision lần nữa trước khi commit để không ghi đè thay đổi vừa được người dùng lưu.

## 4. Bảo toàn dữ liệu

- Không xóa rồi tạo lại nhóm subbox đã hợp lệ.
- Giữ annotation ID, parent ID, nhãn, người gán nhãn, thời gian và audit history.
- Dữ liệu thiếu hoặc nhập nhằng được đưa về trạng thái review thay vì tự suy đoán.
- Kết quả rỗng chỉ hợp lệ khi đã được xác nhận rõ.
- Vùng mới dùng tên theo vị trí ảnh: top, bottom, left, right.
- Dữ liệu vùng legacy giữ nguyên tên và ID.

## 5. Cache, proxy và xoay ảnh

RAW và overlay sử dụng cùng URL ảnh nguồn với version theo revision ảnh. Thay đổi nhãn chỉ đổi metadata nên không làm mất cache bitmap.

Proxy ảnh stream trực tiếp từ MinIO, trả ETag và hỗ trợ If-None-Match/304. Cache không dùng immutable cho object còn có thể bị writer cũ cập nhật.

Khi xoay 90, 180 hoặc 270 độ, backend:

- tạo object nguồn phiên bản mới;
- transform đồng bộ bbox răng, mắc cài và subbox;
- đổi tên vùng canonical theo góc xoay;
- giữ ID và nhãn;
- cập nhật width/height và revision trong transaction;
- giữ nguồn cũ trong lịch sử để rollback.

## 6. Tương thích và chuyển đổi

Trong giai đoạn chuyển đổi, API trả một trong ba chế độ:

- raw: chưa có kết quả dùng được;
- legacy_bitmap: tiếp tục dùng bitmap processed cũ;
- overlay: dùng ảnh nguồn cộng metadata.

Không xóa bitmap legacy trong migration hoặc worker xử lý ảnh. Việc thu hồi object là bước vận hành riêng sau khi đã xác minh overlay, thời gian giữ rollback và tất cả consumer dùng chung bucket.

Công cụ audit chỉ đọc phải:

- gộp nhiều tham chiếu trỏ cùng object;
- kiểm tra ảnh active, soft-deleted và lịch sử nguồn;
- ghi size, ETag, revision và lý do giữ object;
- không ghi DB hoặc xóa MinIO;
- không coi candidate bytes là dung lượng đã thu hồi.

## 7. Thứ tự triển khai

1. Áp dụng migration schema.
2. Triển khai endpoint Python metadata.
3. Triển khai backend worker/API mới.
4. Triển khai frontend overlay và proxy cache.
5. Chuyển đổi theo từng nhóm ảnh, giữ fallback legacy.
6. Review kết quả và tạo manifest audit.
7. Chỉ thu hồi bitmap cũ trong quy trình vận hành có backup, retention và kiểm tra lại tham chiếu.

## 8. Tiêu chí hoàn thành

- Process/reprocess không tạo bitmap processed mới.
- RAW và overlay dùng cùng ảnh nền.
- Không mất ID, nhãn hoặc lịch sử annotation.
- Job retry, partial và review-required được phản ánh đúng.
- Xoay ảnh giữ tọa độ và nhãn đồng bộ.
- Ảnh legacy vẫn xem được trong giai đoạn chuyển đổi.
- Cleanup không chạy tự động và không xóa object còn tham chiếu.
