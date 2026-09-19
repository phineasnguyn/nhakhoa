# Kế hoạch hợp nhất ảnh RAW và chế độ hiển thị processed

Ngày kiểm tra: 18/09/2026. Mã nguồn: commit `2885562`.

Tài liệu được chuyển vào `docs` ngày 19/09/2026, cùng quy ước đặt tên với `docs/delete-patient-cascade-implementation.md` trên branch `feature/delete-patient`.

## Branch và quy trình PR

- Branch mới: `feature/image-storage-optimization`, tạo từ `cuddles47/nhakhoa:dev` tại commit `aa93d0e`, cùng quy trình xuất phát như `feature/delete-patient`.
- Nhánh delete-patient chưa được gộp vào `dev` tại thời điểm tạo branch. Branch tối ưu ảnh không mang theo các commit của feature đó; các phát hiện về worker/outbox trong báo cáo là từ mã đã kiểm tra tại `2885562`, không có nghĩa toàn bộ các thành phần này đã nằm trên branch mới. Khi triển khai phải kiểm tra lại dependency, chỉ đưa vào phần dùng chung thực sự cần thiết hoặc cập nhật base sau khi feature trước được merge.
- Remote làm PR: push branch vào `phineasnguyn/nhakhoa`, sau đó mở PR từ `phineasnguyn:feature/image-storage-optimization` tới `cuddles47/nhakhoa:dev` khi tính năng và kiểm thử sẵn sàng. Chưa tạo PR trong bước chuẩn bị này.
- Workspace VM đã đổi tên ngày 19/09/2026: `/home/dev_phien/nhakhoa` trên `192.168.1.151`. Những đường dẫn `nhakhoa-delete-patient` bên dưới là đường dẫn lịch sử tại thời điểm kiểm kê.
- Giữ Compose project name `nhakhoa-dev` để tiếp tục dùng đúng volume/network hiện có. Các container đang dừng vẫn mang bind mount/label đường dẫn cũ; lần khởi chạy tiếp theo phải dùng Compose từ thư mục mới để recreate container, không dùng `docker start` trực tiếp các container cũ. Chưa khởi động/recreate container trong bước đổi tên.
- `.env.db`, `compose.dev.yml`, `compose.db-external.yml` và thay đổi Vite riêng trên VM được giữ lại ngoài commit tài liệu; không đưa credential hay cấu hình riêng của VM vào PR.

### Môi trường đã xác nhận ngày 19/09/2026

- SSH vào `192.168.1.151` với tài khoản `dev_phien`; dự án đúng là `/home/dev_phien/nhakhoa-delete-patient`, branch `feature/delete-patient`, commit `2885562`.
- Stack Docker đúng: `nhakhoa-dev`, dùng `compose.dev.yml` và `compose.db-external.yml`; DB đích `192.168.1.155:5432/dental_db`. Backend publish cổng 3100, frontend 4104, MinIO 9100/9101. Redis dùng service nội bộ `redis:6379`.
- `/projects/nhakhoa` là checkout khác, branch `duc/allow_yolo_input`, commit `bed223d` và có thay đổi chưa commit. Những phép đo MinIO/Redis của stack `nhakhoa-*` từ lần xác định nhầm thư mục không được dùng làm baseline cho stack `nhakhoa-dev`.
- Docker local Windows không đại diện cho máy chủ, không cần khôi phục Docker local để kiểm tra dữ liệu này.
- `.env.db` và biến môi trường trong container `nhakhoa-dev-backend-1` cùng chứa credential bị DB từ chối với mã `28P01`. Đã kết nối thành công bằng credential từ `backend/.env` của đúng dự án, kết hợp host/port/database đích từ `.env.db`, chỉ trong bộ nhớ tiến trình kiểm tra; không sửa file cấu hình.
- PostgreSQL xác nhận `inet_server_addr() = 192.168.1.155/32`, database `dental_db`, `pg_is_in_recovery() = false`. Các truy vấn chạy trong transaction `READ ONLY`, có statement timeout.

### Số liệu DB và Docker của đúng dự án

| Hạng mục | Kết quả ngày 19/09/2026 |
| --- | --- |
| Ảnh RAW | 116 hàng; 54 có `url_processed`; 36 URL processed phân biệt |
| Ảnh stained | 27 hàng, không có URL processed |
| Kích thước ảnh | RAW không thiếu; cả 27 stained thiếu width/height hợp lệ |
| Annotations | 1.237 hàng, gồm 477 subbox; 12 hàng có `annotated_by` |
| Ảnh processed thiếu dữ liệu | 21/54 không có subbox; trong đó 8/54 không có annotation nào |
| Processing jobs | Bảng tồn tại nhưng không có hàng |
| Storage deletion outbox | Chưa có bảng `public.storage_deletion_jobs` trên DB đích |
| Docker dev | Cả 6 container backend/frontend/postgres/redis/minio/image-processor đang `exited`; `OOMKilled=false` ở cả 6 |
| MinIO dev | Volume `nhakhoa-dev_dev_minio`, bucket `nhakhoa` tồn tại nhưng rỗng |
| Redis dev | Container đã dừng; không có số đo live memory/keyspace cho đúng stack |

Bucket dev được kiểm tra bằng container kiểm kê tạm dùng image đã có, `--network none`, root filesystem read-only và mount volume MinIO read-only; container được tự xóa sau khi hoàn tất. Không khởi động ứng dụng/worker/Redis/MinIO dev và không ghi dữ liệu vào volume.

36 URL processed phân biệt là số tham chiếu trong PostgreSQL, chưa phải số object đã xác minh trong MinIO của đúng môi trường. Bucket dev rỗng cho thấy cấu hình ghép DB thật với MinIO dev chưa cung cấp bộ ảnh tương ứng. Không kết luận 21 ảnh không có subbox đều bị lỗi: có thể là kết quả rỗng hợp lệ hoặc thiếu dữ liệu; phải phân loại trước migration.

### Điều kiện cần giải quyết trước P0 và triển khai

1. Đồng bộ credential DB cho `.env.db`/container theo nguồn credential hợp lệ; không ghi bí mật vào Git hoặc báo cáo.
2. Xác định MinIO chứa ảnh tương ứng DB `.155` và chọn rõ môi trường kiểm thử: trỏ tới kho phù hợp hoặc chuẩn bị bộ dữ liệu dev đồng bộ. Chưa tự đổi endpoint hoặc sao chép dữ liệu.
3. Kiểm tra migration `010_create_storage_deletion_outbox.sql` và các migration/phụ thuộc của branch trước khi sử dụng GC/xóa bệnh nhân. Đợt kiểm tra không chạy migration trên DB đích.
4. Phân loại 21 ảnh processed chưa có subbox, đặc biệt 8 ảnh không có annotations; giữ bitmap cũ đến khi dữ liệu overlay thay thế được xác minh. Bảo toàn 12 annotations đã có người gán nhãn.
5. Sau khi môi trường thống nhất, mới đo object/byte trên MinIO và RAM/keyspace của đúng Redis. Các con số dung lượng của stack khác không thay thế được bước này.

### Kiểm tra lại Docker ngày 19/09/2026

- Docker CLI hoạt động: phiên bản `29.6.2`, build `dfc4efb`.
- Tiến trình Docker Desktop/backend đang chạy, nhưng `wsl --list --verbose` báo distro `docker-desktop` ở trạng thái `Stopped`.
- Log backend lúc 18:52:44 (Asia/Saigon) ghi engine `linux/wsl` chuyển từ `stopped` sang `starting`; tại thời điểm kiểm tra chưa xác nhận engine sẵn sàng.
- Lệnh truy vấn engine/container không trả kết quả trong thời gian kiểm tra. Chưa đọc được danh sách container, trạng thái Redis/MinIO hay số đo dung lượng runtime.
- Log Docker Desktop ghi lần backend trước thoát với status 1 lúc 18:50:42, sau đó khởi chạy lại lúc 18:52:43. Chưa đủ bằng chứng để kết luận nguyên nhân gốc.
- Nếu kiểm tra môi trường local thì cần khôi phục engine Linux/WSL. Bước P0 cho dữ liệu máy chủ phải thực hiện qua SSH như mô tả phía trên. Đợt kiểm tra này không restart/reset Docker hoặc thay đổi volume/container.

## 1. Kết luận và giới hạn kiểm tra

- Luồng divide-corners thực sự lưu thêm bitmap đã vẽ khung vào MinIO; đây là dữ liệu dẫn xuất có thể thay bằng overlay.
- Cùng một hàng `images` chứa `url` và `url_processed`; không phải luồng này tạo hai hàng ảnh trong PostgreSQL.
- Chưa có bằng chứng Redis lưu hai bản ảnh. Mã nguồn dùng Redis cho BullMQ, payload enqueue chỉ có `visitId`, `userId`; kết quả job là số đếm và ID. Không tìm thấy cache binary/base64 ảnh trên Redis.
- Dung lượng tăng không nhất thiết đúng 2 lần: ảnh processed được mã hóa lại, có thể khác kích thước file, chia sẻ hash, hoặc tồn tại nhiều phiên bản mồ côi. Chưa đo được mức tăng thực tế.
- Phần mã nguồn được kiểm tra ngày 18/09; DB đích và Docker đúng dự án đã đối chiếu ngày 19/09 như các bảng phía trên. Chưa đo dung lượng bitmap thật do MinIO dev rỗng và chưa đo live Redis dev vì container đang dừng.
- Chưa sửa luồng ứng dụng, chưa chạy migration hoặc xóa dữ liệu. File này là báo cáo và kế hoạch triển khai.

## 2. Bằng chứng trong mã nguồn

| Vị trí | Hiện trạng và tác động |
| --- | --- |
| `image-processing-service/processors/tooth_divider.py:112` | Chọn nhãn bằng `random.choice([0, 1])`, vẽ rectangle trực tiếp lên ảnh; dòng 219 lưu bằng `cv2.imwrite`. Xử lý lại có thể sinh byte/hash khác. |
| `image-processing-service/app.py:155` | Endpoint batch trả ZIP gồm ảnh và annotations. Đường thành công dùng `background=None`, chưa thấy cleanup thư mục tạm của request. |
| `backend/src/workers/imageProcessor.js:59` | Tải ảnh RAW cả batch vào buffer, gọi Python, nhận ZIP rồi giải nén; tiêu thụ RAM backend và I/O tạm, không phải cache Redis. |
| `backend/src/services/processedImageReferenceService.js:5` | Tạo `processed_by_hash/<sha256>.<ext>`, upload và cập nhật `images.url_processed`; chỉ chống trùng byte trong prefix processed. Không dọn URL cũ tại bước thay tham chiếu này. |
| `frontend/src/features/images/components/ProcessedImageViewer.jsx:390` | Thumbnail processed sử dụng `url_processed`. Lightbox cũng chọn URL này trước khi truyền vào `AnnotationCanvas` ở dòng 954. |
| `frontend/src/components/AnnotationCanvas.jsx:61` | Vẽ ảnh nền rồi vẽ bbox/subbox lần nữa: có thể chồng overlay lên khung đã nằm trong bitmap. |
| `frontend/src/components/ImageUpload.jsx:64` | Hai hàm tải danh sách gắn `Date.now()` vào URL; cùng nội dung có cache key mới sau mỗi lần reload. |
| `backend/src/routes/api.js:102` | Proxy đọc toàn bộ object vào buffer và đặt cache HTTP 1 giờ; không có Redis image cache tại đây. |
| `backend/src/controllers/ImageProcessingController.js:116` | Enqueue theo visit, không enqueue riêng RAW và processed. Trạng thái ảnh ở nhiều nhánh vẫn suy ra từ sự tồn tại `url_processed`. |
| `backend/src/config/queue.js:21` | BullMQ giữ tối đa 100 completed jobs và 200 failed jobs theo cấu hình hiện tại. |
| `backend/src/services/datasetExportService.js:297` | Export dataset tải `image.url`; phải tiếp tục giữ ảnh nguồn sạch khi thay kiến trúc. |
| `backend/src/services/storageDeletionService.js:89` | Đã có cơ chế kiểm tra tham chiếu và advisory lock để xóa object dùng chung; có thể tái sử dụng cho migration. |

## 3. Kiến trúc đích

```text
MinIO: một object ảnh nguồn cho mỗi ảnh logic
                  |
            URL + image_revision
                  |
        ảnh nền dùng chung trên giao diện
                  + chế độ RAW: tắt overlay
                  + chế độ processed: bật bbox răng, mắc cài và subbox

PostgreSQL: image_annotations + processing_status + annotation_revision
Redis: hàng đợi ID/trạng thái; không thêm cache bitmap processed
```

Một object ở đây áp dụng cho cặp RAW/processed chỉ khác khung vẽ. Ảnh stained và ảnh augmentation có biến đổi nội dung thật vẫn là tài sản riêng.

Giữ `images.id` và các annotation ID ổn định. Dùng `processing_status` cùng phiên bản ảnh/annotations để xác định kết quả xử lý hợp lệ; không dùng `url_processed` hoặc số annotations lớn hơn 0 để kết luận thành công. Ảnh không có răng phù hợp vẫn có thể xử lý thành công với kết quả rỗng.

## 4. Thứ tự triển khai

### P0 — Kiểm kê và chốt baseline

1. Đối chiếu phiên bản đang chạy với mã nguồn này.
2. Thống kê số ảnh RAW, ảnh có `url_processed`, object distinct, tổng byte của RAW, processed đang tham chiếu và processed mồ côi. Không cộng lặp object được nhiều hàng cùng tham chiếu. Kiểm tra cả phiên bản object nếu bucket bật versioning.
3. Đo Redis `INFO memory`, số lượng job theo trạng thái, lấy mẫu `SCAN` + `TYPE` + `MEMORY USAGE`; chỉ xem schema/kích thước, tránh xuất payload nhạy cảm. Phân biệt bộ nhớ queue, RSS/fragmentation và cache nếu production có thành phần ngoài repo.
4. Đo browser Network, số request/byte khi chuyển RAW–processed và reload danh sách; đo RSS backend/Python và dung lượng temp trước/sau batch.
5. Kiểm tra ảnh thiếu width/height, annotations bác sĩ đã sửa, ảnh đã xoay và khả năng dựng overlay từ dữ liệu hiện có.

### P1 — Giao diện và contract dữ liệu

1. Cả thumbnail và lightbox dùng cùng `image.url`; bật/tắt riêng lớp overlay. Tái sử dụng ảnh nền đã tải, không tạo canvas kích thước ảnh gốc cho từng thumbnail.
2. Hoàn thiện renderer phân biệt răng và mắc cài, vẽ đúng bốn subbox, hỗ trợ hover/click/zoom/rotation. Hiện API gom mọi parent vào `teeth`, cần phân loại rõ để tránh hiển thị mắc cài như một răng.
3. Đưa annotations cho lưới ảnh qua API batch theo visit hoặc tải khi cần, tránh một request cho mỗi ô sau mỗi render.
4. Thay mọi điều kiện dựa vào `url_processed` ở UI, API trạng thái và worker bằng trạng thái xử lý có revision. Giữ field cũ tạm thời để chuyển đổi tương thích.
5. Bổ sung `image_revision` và `annotation_revision` hoặc cơ chế phiên bản tương đương. Ảnh đổi/xoay mới đổi revision ảnh; sửa nhãn chỉ đổi revision annotations.
6. Nếu annotation chưa đủ để dựng lại một ảnh lịch sử, đánh dấu cần kiểm tra/tính lại hình học, không suy diễn thành công chỉ vì có URL cũ.

### P2 — Ngừng tạo bitmap processed

1. Tách hàm tính bốn vùng khỏi hàm vẽ ảnh. Trong luồng hiện tại hình học chỉ dựa trên bbox răng/mắc cài và kích thước ảnh; có thể thêm endpoint nhận metadata và trả JSON annotations, không cần truyền pixel ảnh sau khi đã xác thực kích thước.
2. Worker gọi contract mới, bỏ upload `processed_by_hash`, ZIP ảnh và đọc/ghi temp cho luồng divide-corners. Giữ augmentation và chức năng xuất ảnh có khung theo yêu cầu tách biệt.
3. Ghi annotations và trạng thái completed trong cùng transaction. Kết quả lỗi từng ảnh phải thể hiện đúng partial/failed; hiện annotation parse lỗi vẫn có thể bị bỏ qua và tăng processedCount.
4. Kiểm tra revision đầu vào trước khi commit để kết quả cũ không ghi đè ảnh vừa xoay/thay. Giữ khóa phối hợp với luồng xóa bệnh nhân.
5. Không tạo nhãn plaque ngẫu nhiên. Giữ nhãn bác sĩ, lưu trạng thái chưa đánh giá cho vùng mới hoặc prediction từ nguồn hợp lệ. Reprocess phải idempotent, không xóa rồi tạo lại nhãn đã duyệt.
6. Sửa contract vùng: Python trả G/I/M/D trong khi worker gán thứ tự thành top_left/top_right/bottom_left/bottom_right. Chốt mapping hiển thị/nghiệp vụ rõ ràng; không đổi nghĩa dữ liệu lịch sử chỉ bằng đổi tên hàng loạt.
7. Bỏ giả định trung gian 1024×1024 và fallback 6240×4160 khi không biết kích thước. Chuyển tọa độ theo kích thước thật, tránh làm tròn hai lần; xác thực bbox nằm trong ảnh. Nguồn ảnh thiếu metadata phải được đọc kích thước một lần.

### P3 — Sửa cache và bộ nhớ

1. Thay timestamp theo lần tải bằng URL ổn định có `?v=<image_revision>`. RAW và processed dùng đúng cùng một URL.
2. Thêm ETag/conditional request ở proxy, kiểm tra trước khi tải toàn bộ nội dung. Stream MinIO → HTTP với backpressure để giảm buffer của Node. Chọn cache policy phù hợp quyền truy cập ảnh.
3. Canvas giữ ảnh nền, chỉ redraw overlay khi hover/sửa nhãn; giới hạn backing store theo kích thước hiển thị và device pixel ratio, giữ phép đổi tọa độ/hit test chính xác. Đóng viewer thì giải phóng tài nguyên không dùng.
4. Redis tiếp tục chứa payload job nhỏ. Chỉ điều chỉnh retention sau đo đạc; không cần thêm một lớp Redis cache ảnh để thực hiện kế hoạch này. Nếu sau này cache annotations, dùng cache nhỏ theo image ID/revision và invalidation rõ ràng.

### P4 — Chuyển dữ liệu cũ và thu hồi dung lượng

1. Triển khai schema/contract tương thích trước, rồi viewer mới, sau đó mới chuyển worker sang metadata-only bằng feature flag. Không để worker mới chạy khi viewer cũ còn phụ thuộc URL bitmap.
2. Backfill trạng thái/revision theo dữ liệu đã kiểm tra; giữ nguyên image ID, annotation ID, người sửa và thời gian sửa. Không bắt buộc chạy lại toàn bộ dataset.
3. Tạo manifest gồm image ID, URL processed cũ, object key, số byte và kết quả kiểm tra; dry-run trước. Chỉ bỏ tham chiếu processed khi ảnh gốc và overlay thay thế đã được xác nhận.
4. Đưa object cũ vào outbox GC có thời gian chờ rollback. Dùng nhánh xóa object shared với kiểm tra tất cả tham chiếu ngay trước xóa, kể cả ảnh soft-delete; dùng advisory lock như writer hiện tại. Không xóa thẳng cả prefix.
5. Quét riêng object mồ côi trong `processed_by_hash` vì xóa bệnh nhân hiện chỉ liệt kê prefix `visits/<id>/` và URL đang được tham chiếu; cần grace period và phối hợp dừng writer cũ để tránh đua ghi/xóa.
6. Rollback trước GC: phục hồi mapping từ manifest và bật lại reader cũ. Sau xóa vật lý, muốn phục hồi bitmap phải có backup hoặc dựng lại; không coi rollback ứng dụng là đủ.

## 5. Tiêu chí nghiệm thu

- Upload một RAW rồi xử lý không tạo thêm object ảnh processed; xử lý lại không tăng số object.
- Chuyển RAW/processed chỉ thay overlay và không tải một bitmap khác; reload không đổi URL khi ảnh chưa đổi.
- Răng, mắc cài, bốn vùng khớp ở ảnh ngang/dọc, ảnh kích thước khác nhau, zoom và rotation; không còn đường khung đã ghi vào ảnh nền.
- Sửa nhãn chỉ ghi metadata; reprocess giữ annotation đã duyệt, không sinh nhãn ngẫu nhiên.
- Processing thành công với kết quả rỗng, lỗi từng ảnh, retry, xoay đồng thời và xóa bệnh nhân đều có trạng thái đúng.
- Export YOLO/COCO vẫn dùng ảnh nguồn sạch và tọa độ đúng; stained/augmentation không bị gộp nhầm.
- GC giữ object còn tham chiếu; retry/rollback được kiểm chứng trên dữ liệu thử trước production.
- Báo cáo trước/sau tách rõ byte MinIO, Redis used_memory/RSS, RSS backend/Python, temp disk và browser network/memory.

Mức tiết kiệm MinIO cần tính bằng tổng byte các object processed thực sự có thể xóa. Nếu mỗi RAW chỉ có một processed với dung lượng gần bằng nhau, tiết kiệm xấp xỉ 50% phần dung lượng của cặp ảnh đó; không phải 50% toàn bucket. Chưa có cơ sở cam kết Redis giảm 50%.
