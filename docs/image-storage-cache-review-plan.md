# Kế hoạch tối ưu lưu trữ và hiển thị ảnh

Rà soát cuối: 20/09/2026. Trạng thái: **đã triển khai luồng RAW + overlay và công cụ kiểm kê chỉ đọc; kiểm thử bằng fixture tách biệt. Chưa chuyển đổi/xóa dữ liệu dùng chung.** Kết quả và hướng dẫn vận hành: [image-storage-optimization-implementation.md](image-storage-optimization-implementation.md).

## 1. Branch, môi trường và phạm vi

- Branch duy nhất: `feature/image-storage-optimization`, đã nhận toàn bộ lịch sử từ nhánh gõ thiếu chữ `a`. Đã merge nguyên lịch sử `feature/delete-patient` tại `2885562`; đã cập nhật `origin/dev` tại `cbaf894` (PR #5 merge delete-patient), không có conflict.
- Push lên `phineasnguyn/nhakhoa`; PR sau triển khai nhắm vào `cuddles47/nhakhoa:dev`.
- VM: `192.168.1.151`, workspace hiện tại `/home/dev_phien/nhakhoa`. Thư mục cũ `nhakhoa-delete-patient` đã được đổi tên.
- Compose project giữ tên `nhakhoa-dev`; cấu hình riêng của VM và credential không đưa vào Git.
- Các container cũ đang dừng vẫn giữ bind mount/label đường dẫn cũ. Khi chạy kiểm thử, recreate bằng Compose từ workspace mới; không dùng `docker start` trực tiếp.
- Root screen `backend` và `frontend` đang chạy từ `/projects/nhakhoa`, là checkout khác. Không restart/chuyển branch của các tiến trình đó. PostgreSQL standalone trên 151 đang phục vụ demo của nhóm; dev tại `/home/dev_phien/nhakhoa` dùng Patroni 155–157, primary được kiểm tra là 155. Fixture tự động dùng container tạm riêng, không dùng DB demo hoặc `dental_db` dùng chung.

**Quyết định theo yêu cầu người dùng:** lấy nền BullMQ từ `feature/delete-patient` trước khi tối ưu ảnh. Đã cherry-pick commit `0b54132` thành `c1b1aef`, sau đó lấy controller, worker và service lưu tham chiếu cùng các bản sửa tại `2885562`. Tách phần tính/lưu annotations thành service do worker gọi; HTTP chỉ enqueue và trả trạng thái job.

Phạm vi hiện tại kế thừa cả BullMQ, API xóa bệnh nhân, outbox và migration 008–010 từ delete-patient. Worker vẫn khởi động cleanup outbox. Luồng xử lý ảnh mới chỉ ghi overlay metadata; kiểm tra tham chiếu của cleanup đã bổ sung lịch sử nguồn ảnh sau xoay.

Mục tiêu bắt buộc: một bitmap nguồn đang được sử dụng cho mỗi ảnh logic, chế độ processed là ảnh nguồn cộng overlay; xử lý và sửa nhãn không tạo bitmap processed. Ảnh stained, augmentation và phiên bản ảnh phát sinh do thay/xoay là nội dung khác, không gộp với RAW bằng dedup theo hình thức hiển thị.

## 2. Hiện trạng xác minh

### 2.1 Baseline trước triển khai (ghi nhận ngày 19/09/2026)

| Vị trí trên base hiện tại | Phát hiện |
| --- | --- |
| `backend/src/controllers/ImageProcessingController.js` | Sau khi port: tạo processing job trong transaction, commit trước khi enqueue bằng ID DB; trả HTTP 202 và jobId; từ chối job trùng trên visit. |
| `backend/src/workers/imageProcessor.js` | Worker tải RAW, gửi Python, nhận ZIP, lưu processed và annotations. Parser hiện vẫn xóa subbox không phải YOLO trước khi ghi lại, dùng kích thước trung gian 1024, parent theo class ID, vùng theo thứ tự và dummy input. Đây là điểm sửa chính ở P2. |
| `backend/src/services/processedImageReferenceService.js` | Bản port giữ khóa image và advisory lock theo object khi upload/hash rồi cập nhật URL; chưa có GC/outbox trên branch này. |
| `image-processing-service/processors/tooth_divider.py` | Tính bốn vùng bằng bbox răng/mắc cài; vẽ khung và ghi ảnh; gán class ngẫu nhiên. Chưa có suy luận plaque thật trong bước này. |
| `ProcessedImageViewer.jsx`, `AnnotationCanvas.jsx` | Thumbnail và lightbox chọn bitmap processed; canvas tiếp tục vẽ khung lên ảnh đã có khung. |
| `frontend/src/components/ImageUpload.jsx` | Hai luồng tạo URL dùng `Date.now()`; lần tải danh sách mới làm thay cache key dù nội dung không đổi. |
| `backend/src/routes/api.js`, `services/storage.js` | Proxy tải toàn bộ object vào buffer, cache HTTP 1 giờ. |
| `backend/src/controllers/ImageController.js` | Xoay ảnh ghi đè object, xóa subbox nhưng giữ nguyên bbox cha và chưa cập nhật width/height; chỉ đổi cache key sẽ không khắc phục tọa độ sai. |
| `backend/src/services/annotationService.js` | YOLO upload có subbox riêng, thậm chí tạo parent từ subbox; không được coi các dữ liệu này là đầu vào cần sinh lại bằng Python. |
| `backend/src/services/datasetExportService.js` | Export dùng RAW. Nhánh COCO kiểm tra chuỗi `'plaque'` trong khi DB dùng số 0/1: cần regression test và sửa mapping tại chỗ, không làm lại toàn bộ export. |

Bảng trên ghi nhận baseline, không phải hành vi sau triển khai. Các thay đổi cuối được mô tả trong báo cáo implementation. Migration 008–010 và dependency xóa bệnh nhân hiện đã được kế thừa đầy đủ.

Redis của luồng đã port chứa BullMQ metadata, payload job chỉ gồm visitId/userId (luồng mới thêm processingJobId); không cache binary/base64 ảnh. Retention hiện tại: 100 completed jobs, 200 failed jobs, tối đa 2 lần thử. Nhận định “Redis tốn RAM gấp đôi vì RAW/processed” chưa được chứng minh.

### 2.2 Dữ liệu đã kiểm tra trên DB .155 ngày 19/09/2026

Truy vấn từ đúng workspace trên .151, bằng PostgreSQL transaction `READ ONLY` có timeout. Server xác nhận `192.168.1.155/32`, database `dental_db`, không phải replica.

| Hạng mục | Kết quả |
| --- | --- |
| RAW | 116 hàng; 54 có URL processed; 36 URL processed phân biệt |
| Stained | 27 hàng; không có URL processed |
| Width/height | RAW đầy đủ; 27 stained thiếu kích thước hợp lệ |
| Annotations | 1.237 hàng; 477 subbox; 12 hàng có `annotated_by` |
| Processed thiếu annotations | 21/54 không có subbox; trong đó 8/54 không có annotation nào |
| Processing jobs | Bảng tồn tại nhưng rỗng |
| Storage deletion outbox | Bảng `storage_deletion_jobs` chưa tồn tại |
| Docker đúng stack | Cả 6 container `nhakhoa-dev` đang dừng, không ghi nhận OOMKilled |
| MinIO dev | Volume `nhakhoa-dev_dev_minio`, bucket `nhakhoa` tồn tại nhưng rỗng |
| Redis dev | Đã dừng; chưa có số đo live memory/keyspace |

Bucket được đọc qua mount read-only trong container kiểm kê tạm không có network. Không khởi động ứng dụng, không chạy migration hoặc xóa dữ liệu thật.

Ở lần kiểm tra 19/09, credential trong `.env.db` và container dev bị từ chối với `28P01`. Credential trong `backend/.env` của đúng workspace kết nối được khi dùng host/port/database của `.env.db`, chỉ ghi đè trong bộ nhớ tiến trình kiểm tra. Ngày 20/09 đã chỉnh `backend/.env` và `.env.db` riêng của workspace về `192.168.1.155:5432/dental_db`, dùng credential đã xác minh; không đưa vào Git, không restart dịch vụ.

36 URL không đồng nghĩa 36 object tồn tại trong bucket dev. Bucket rỗng và DB có ảnh là cấu hình dữ liệu chưa đồng bộ. Không tự coi 21 ảnh thiếu subbox là lỗi: phải phân biệt chưa có dữ liệu, kết quả rỗng hợp lệ và dữ liệu bị mất.

## 3. Các quyết định kỹ thuật đã chốt

### 3.1 Ảnh nền và trạng thái xử lý

- Giữ một `images.id`, một `images.url` làm ảnh nguồn; không tạo hàng ảnh riêng cho processed, không gán giả `url_processed = url`.
- API trả trạng thái hiển thị rõ: `raw`, `legacy_bitmap`, `overlay`, và lý do cần kiểm tra nếu có. Chỉ cho `overlay` khi metadata đã được xác thực cho revision ảnh hiện tại.
- Đề xuất migration cộng thêm: `image_revision` mặc định 1; `annotation_revision` mặc định 0; `processed_image_revision` nullable; `overlay_schema_version` nullable. Giữ `url_processed`, `processing_status`, `processed_at` trong giai đoạn tương thích.
- `completed` + revision khớp + schema overlay hợp lệ mới chứng minh kết quả overlay sẵn sàng. Kết quả rỗng chỉ được đánh dấu hợp lệ khi đã xác nhận nguồn annotations hợp lệ; thiếu input không được giả thành kết quả âm tính.
- Tên migration mới tránh chiếm số 008–010 của feature delete-patient, ví dụ `011_add_image_overlay_metadata.sql`; idempotent, chạy thử cả database mới và database hiện có. Không giả định thêm file init sẽ tự migrate volume cũ.

### 3.2 Contract tính hình học

- Thêm endpoint Python nhận JSON metadata, không nhận ảnh: image ID/revision, width/height, bbox răng và mắc cài cùng **annotation ID thật**.
- Chỉ đưa parent teeth/brackets vào bộ tính; subbox hiện có không trở thành “răng” mới. Bỏ dummy annotations và các luồng đọc bitmap/COCO không cần thiết trong worker.
- Trả parent annotation ID, bbox pixel `[x,y,w,h]`, mã vùng không nhập nhằng, số vùng và lỗi theo từng ảnh. Không dùng class răng làm khóa duy nhất vì nhiều parent có thể cùng class.
- Hệ tọa độ là ảnh nguồn đã xác minh orientation và kích thước thực; không qua bước làm tròn 1024×1024. Thiếu kích thước thì đọc metadata ảnh một lần; không đoán 6240×4160.
- Mã vùng mới dùng vị trí ảnh `top/bottom/left/right`. Không suy diễn tên giải phẫu G/I/M/D khi chưa có hướng chụp đầy đủ. Dữ liệu cũ `top_left/...` giữ nguyên; chỉ ánh xạ khi đã xác minh hình học/nguồn tạo, không đổi tên hàng loạt.
- Giữ nguyên quy tắc chọn mắc cài của thuật toán hiện có cho ca không nhập nhằng; trường hợp nhiều ứng viên, bbox vượt biên hoặc vùng có diện tích <= 0 phải trả lý do cần kiểm tra. Chỉ yêu cầu đủ bốn vùng với cặp răng–mắc cài hợp lệ.
- Metadata endpoint không gọi hàm vẽ, `cv2.imwrite`, không tạo ZIP, không sinh prediction ngẫu nhiên. Endpoint cũ chỉ giữ trong giai đoạn tương thích; augmentation không đổi.

### 3.3 Nhãn, reprocess và đồng thời

- Bảo toàn annotation ID, quan hệ parent, `plaque_status`, `annotated_by`, `annotated_at`, `annotation_history` và nhãn YOLO đã nhập. Không delete/reinsert các subbox đã có nhãn.
- Không đổi quy ước 0/1 hoặc mặc định `plaque_status=1` đang có cho subbox sinh tự động trong PR tối ưu. Giá trị mặc định không được coi là bác sĩ đã xác nhận. Giữ nguyên null nếu có; prediction mới chưa có mô hình thì null. Loại bỏ ngẫu nhiên ở đường xử lý mới.
- Upsert hình học theo parent ID + vùng đã xác minh. Không cập nhật đè bbox/nhãn YOLO được nhập; nếu nguồn mâu thuẫn, trả cần kiểm tra thay vì tự sửa. Không thêm unique index lên dữ liệu cũ trước khi kiểm tra trùng/khác quy ước vùng.
- Mỗi ảnh dùng một transaction trên cùng DB client: kiểm tra ảnh/visit/patient còn hiệu lực, đối chiếu revision đầu vào, lưu annotations rồi mới đặt completed và revision kết quả.
- Mọi đường sửa annotations liên quan phải tăng `annotation_revision` trong cùng transaction, gồm sửa nhãn đơn/batch, import và xử lý. Kết quả tính từ snapshot cũ bị từ chối nếu image/annotation revision đã đổi; không ghi đè thay đổi bác sĩ vừa lưu.
- Trước khi bật writer mới trên dữ liệu dùng chung, tất cả ứng dụng có quyền sửa cùng ảnh/annotations phải tuân thủ revision này hoặc được ngừng ghi trong phạm vi chuyển đổi. Chỉ sửa writer của workspace mới không bảo vệ được trước một ứng dụng cũ vẫn ghi vào DB .155 mà không tăng revision.
- Với request xử lý đồng thời, chỉ một kết quả snapshot được commit. HTTP trả kết quả từng ảnh và số completed/failed/review-required thật; không báo toàn visit thành công chỉ vì Python trả một số file.
- Giữ contract bất đồng bộ đã port: POST trả HTTP 202 với jobId; GET trạng thái và frontend polling theo dõi đúng job. Payload/result Redis chỉ chứa ID, progress, số đếm và lý do lỗi theo ảnh; annotations nằm ở PostgreSQL, không nhét bitmap vào job.
- P2 phải phân biệt retry đang chờ với failed cuối cùng, xử lý partial/review-required và bảo đảm polling kết thúc đúng. Pipeline kế thừa hiện ghi failed ngay khi một attempt lỗi; không được để UI kết luận thất bại khi BullMQ còn retry. Bổ sung giới hạn polling, hủy khi unmount và không trả trạng thái của một job mới hơn thay cho job đang theo dõi.
- Kiểm tra phục hồi job creating bị bỏ dở giữa commit DB và enqueue, hoặc job processing khi worker dừng; không để visit bị khóa vĩnh viễn. Reconcile phải idempotent theo DB jobId, không enqueue lại job đã chạy thành công.

### 3.4 Cache và thay/xoay ảnh

- RAW và overlay dùng cùng URL ổn định có version nội dung; sửa nhãn chỉ đổi annotation revision, không đổi URL ảnh.
- Tất cả đường upload/replace/rotate phải cập nhật revision và kích thước; các URL presigned, tương đối và proxy phải chuẩn hóa về cùng object identity, không gắn timestamp theo lần tải.
- Proxy thêm ETag/conditional GET từ metadata MinIO; chỉ mở body stream khi cần và xử lý ngắt kết nối/backpressure. Query `v=` tự nó không phải bảo đảm nội dung bất biến: không gắn `immutable` lên object key còn bị ghi đè. Cache policy phải phù hợp cơ chế xác thực đang triển khai.
- Renderer dùng cùng ảnh nền, lớp overlay riêng, backing store theo kích thước hiển thị/DPR; hover không decode hay vẽ lại toàn bộ ảnh gốc. Có cleanup khi đóng viewer.
- Với xoay 90/180/270°, transform đồng bộ bbox của cả răng, mắc cài và subbox, cập nhật width/height, giữ ID/nhãn/history. Hệ tọa độ EXIF/display phải thống nhất; input không đủ để xác định transform thì từ chối thao tác thay vì xóa nhãn.
- Mã vùng theo vị trí ảnh của dữ liệu mới phải đổi tương ứng sau xoay; giữ ID của vùng cùng nhãn đi theo bbox đã transform, không gán nhãn cũ sang vùng khác chỉ vì tên top/left đổi.
- Không tự reprocess rồi xóa nhãn sau xoay. Nếu cần tính lại hình học, thực hiện qua cơ chế giữ nhãn và revision ở trên.
- Tránh trạng thái “object đã bị ghi đè nhưng transaction DB thất bại”: upload ảnh xoay thành object nguồn phiên bản mới, sau đó CAS tham chiếu DB/revision; thất bại thì giữ nguồn cũ và ghi nhận object mới cần dọn. Phiên bản cũ giữ tạm cho rollback, không phải bitmap overlay dư thừa.

### 3.5 Đọc dữ liệu cũ và thu hồi dung lượng

- Viewer hỗ trợ cả legacy bitmap và RAW + overlay. Ảnh chưa đủ annotations tiếp tục dùng bitmap cũ, **không vẽ thêm canvas lên bitmap đó**. Lỗi tải annotations không được hiển thị RAW như thể overlay đã hoàn tất.
- Đánh dấu overlay-ready theo từng ảnh sau xác minh; không chỉ đếm “có 4 subbox”. Nhóm YOLO hợp lệ có thể dùng bbox nhập sẵn dù không có bbox mắc cài để sinh lại.
- Outbox delete-patient chỉ phục vụ luồng xóa bệnh nhân; không tự enqueue xóa bitmap cũ sau xử lý. Chuẩn bị công cụ quản trị cleanup riêng: dry-run là mặc định, manifest có DB identity, bucket/endpoint, image/revision, object key, size/ETag, URL cũ và trạng thái từng bước. Manifest chứa tham chiếu dữ liệu thật lưu ngoài Git.
- Lập manifest trước khi bỏ tham chiếu legacy; chỉ xóa các object của ảnh đã chuyển đổi được xác minh, hết thời gian giữ rollback. Gộp theo object identity vì 54 tham chiếu hiện chỉ có 36 URL khác nhau.
- Trước apply, kiểm tra tất cả DB/app dùng chung bucket, mọi tham chiếu ảnh/annotations kể cả soft-delete. Chưa rõ có consumer khác thì không đưa object đó vào danh sách xóa.
- Base hiện chưa có giao thức khóa chung với writer cũ. Cleanup chỉ chạy trong cửa sổ bảo trì đã dừng và drain các writer liên quan; khóa trong một DB không bảo vệ writer của ứng dụng khác. Delete-patient đã merge, nhưng GC bitmap cũ vẫn là thao tác riêng cần kiểm tra consumer dùng chung; không dùng outbox để bỏ qua điều kiện này.
- Xóa có checkpoint, retry idempotent, stat lại ETag/version trước xóa. Bucket có versioning phải thống kê cả phiên bản; delete marker chưa đồng nghĩa đã thu hồi byte.
- Các object mồ côi ngoài manifest chỉ báo cáo; chỉ thu hồi sau khi xác minh phạm vi tham chiếu riêng. Không xóa cả prefix.
- Rollback mặc định về bản ứng dụng tương thích cả overlay và bitmap. Chỉ tắt feature flag không làm ứng dụng rất cũ đọc được ảnh mới không có `url_processed`; nếu buộc rollback sâu phải dựng lại bitmap từ dữ liệu/backup trước. Sau GC, manifest đơn thuần không khôi phục được byte đã xóa.

## 4. Thứ tự thực hiện và điểm kiểm tra

| Bước | Công việc | Điều kiện hoàn thành |
| --- | --- | --- |
| P0 — Chuẩn bị dev | Nền BullMQ đã port; dùng DB dev + bucket dev + Redis dev và fixture đồng bộ; áp dụng/kiểm tra migration 008 trên DB dev, cài dependencies theo lockfile. Tách cấu hình dev khỏi `.env.db` trỏ DB thật. | Có môi trường viết thử độc lập; queue/worker/job status hoạt động, baseline DB–bucket–code rõ. Lỗi credential DB thật không chặn code/unit test. |
| P1 — Schema và API tương thích | Migration cộng thêm, revisions, trạng thái render, API đọc annotations theo visit hoặc batch, viewer fallback legacy; chưa đổi writer mặc định. | Dữ liệu cũ vẫn xem được, schema mới hỗ trợ kết quả rỗng đã xác minh. |
| P2 — Metadata processing | Endpoint hình học JSON; service backend được BullMQ worker gọi; transaction/revision, retry/reconcile, giữ nhãn; cập nhật import và trạng thái partial/polling. | Xử lý/reprocess không tạo object ảnh; không truyền pixel cho ảnh đủ metadata; API enqueue/status và retry có kết quả đúng. |
| P3 — Viewer/cache/rotation | Dùng RAW + overlay cho lưới/lightbox; cache ổn định, stream/ETag; cập nhật tất cả đường ghi ảnh và xoay an toàn. | Chuyển chế độ/sửa nhãn không tải bitmap thứ hai; ảnh xoay và tọa độ khớp, không mất nhãn. |
| P4 — Dữ liệu lịch sử | Công cụ dry-run/phân loại, manifest, chọn nhóm nhỏ đủ điều kiện; hỗ trợ fallback nhóm thiếu dữ liệu. | Không tự chuyển 21 ảnh thiếu subbox; các ảnh được chọn có preview xác minh và rollback rõ. |
| P5 — Thu hồi storage | Kiểm kê đúng kho ảnh thật, xác định consumer, dừng/drain writer liên quan, apply manifest đã qua thử nghiệm; theo dõi checkpoint. | Chỉ xóa object không còn tham chiếu; có thống kê byte thực sự thu hồi. |

P1–P4 là code và công cụ cần hoàn tất trên branch. P5 là thao tác vận hành riêng sau kiểm thử; không chạy ngầm cùng migration hoặc lúc backend khởi động. Chưa có đủ mapping kho ảnh thật/consumer và môi trường ghi thử thì không chạy P5 hay integration test ghi vào DB .155.

Không chạy kiểm thử tích hợp xóa bệnh nhân trên DB dùng chung. Feature ảnh có runner riêng tạo PostgreSQL/MinIO/Redis/Python tạm và tự thu dọn fixture.

## 5. Ma trận kiểm thử bắt buộc

| Nhóm | Ca kiểm thử và yêu cầu |
| --- | --- |
| Geometry | Ảnh ngang/dọc, kích thước thật khác 1024, bbox sát biên; không mắc cài, nhiều mắc cài, cùng class răng nhưng parent ID khác; chỉ bbox hợp lệ mới sinh vùng. |
| Input và legacy | Thiếu annotations không sinh dummy; kết quả rỗng hợp lệ phân biệt missing-input; ảnh legacy không annotations vẫn xem được bitmap; YOLO có subbox không bị sinh lại/đổi nhãn. |
| Idempotency/nhãn | Process hai lần: số object không tăng, ID/nhãn/history được giữ; không có prediction ngẫu nhiên; lỗi ghi DB không để completed một phần. |
| Đồng thời | Hai process; process với sửa nhãn, rotate/replace hoặc soft-delete: kết quả cũ không commit lên revision mới/ảnh đã xóa. |
| BullMQ | Enqueue trả 202; jobId thống nhất DB–Redis; job trùng 409; enqueue lỗi không để creating treo; retry không làm UI báo failed sớm; worker crash/restart và job creating bỏ dở được reconcile; partial/poll timeout/cancel; Redis không chứa bitmap. |
| Rotation | 90/180/270°, đổi width/height, răng–mắc cài–subbox và click hit-test khớp; lỗi upload/DB giữ được ảnh cũ và nhãn. |
| UI/cache | Grid/lightbox dùng chung URL; thay chế độ không request bitmap khác; sửa nhãn chỉ refresh overlay; reload không đổi version vô cớ; thay ảnh đổi version; 304, stream lỗi và client disconnect được xử lý. |
| Export | YOLO/COCO dùng ảnh sạch và tọa độ đúng; 0/1/null được kiểm tra, COCO không đổi nhãn số 1 thành class 0. Không thay quy ước label import trong PR này. |
| Migration | Fresh DB và schema hiện có; chạy lại không lỗi; dữ liệu lịch sử không tự thành overlay-ready; image ID/annotation ID/history không đổi. |
| Cleanup | Hai ảnh dùng chung object, soft-delete, bucket có consumer khác, ETag đổi, retry sau xóa một phần, rollback trước/sau GC; dry-run không ghi/xóa tài sản. |
| Hiệu năng | Ghi số request/byte khi chuyển chế độ, object/byte trước–sau, RSS backend/Python/browser. Chỉ đo Redis của đúng stack nếu có consumer; không cam kết giảm 50% Redis. |

Chạy unit tests backend/Python phù hợp với các thay đổi, frontend production build, kiểm thử API + MinIO/PostgreSQL trên fixture riêng, kiểm tra trực quan browser và `git diff --check`. Test chỉ có subboxMapper ở base không đủ chứng minh feature hoàn thành.

## 6. Tiêu chí chốt triển khai

- Luồng mới không tạo bitmap processed; sửa nhãn chỉ ghi metadata. Mục tiêu “một ảnh” là một nguồn đang được sử dụng, có thể giữ revision/legacy tạm trong thời gian rollback.
- Overlay-ready phải được xác minh cho đúng revision, không dựa vào `url_processed` hoặc số subbox đơn thuần.
- Dữ liệu bác sĩ/YOLO và lịch sử được bảo toàn; RAW/stained/augmentation không gộp nhầm.
- BullMQ là dependency đã chủ động lấy từ delete-patient theo yêu cầu người dùng; outbox/xóa bệnh nhân được giữ nguyên chức năng và kiểm tra thêm tham chiếu lịch sử nguồn. Không hứa lợi ích Redis không có số đo.
- Tiết kiệm storage = tổng byte các object thực sự thu hồi sau loại trùng và kiểm tra tham chiếu. Chỉ gần 50% dung lượng của cặp RAW/processed khi hai file gần bằng nhau; không phải 50% toàn bucket.
- Điều kiện để chuyển đổi dữ liệu thật còn mở: cấu hình DB hợp lệ cho triển khai, kho MinIO đúng với DB .155, danh sách consumer dùng chung và phân loại nhóm ảnh lịch sử. Các điều kiện này không cản trở bắt đầu code trên fixture dev.

## 7. Kết quả khôi phục BullMQ

- Commit `c1b1aef`: cherry-pick nền BullMQ từ `0b54132` của delete-patient. Commit `450a537`: port controller/worker/service lưu tham chiếu đã sửa tại `2885562`, loại bỏ dependency worker xóa storage và bổ sung test job trùng/enqueue lỗi.
- Đã push branch lên fork và đồng bộ workspace `/home/dev_phien/nhakhoa`; cài backend dependencies theo lockfile bằng `npm ci`. Các file cấu hình riêng của VM được kiểm tra giữ nguyên nội dung.
- `npm run test:unit` trên local và VM: 5/5 test đạt, cùng kiểm tra subboxMapper. Bao phủ thứ tự commit/enqueue, ID job DB–Redis, job trùng 409, enqueue lỗi, khóa tham chiếu ảnh và không upload khi ảnh không còn tồn tại.
- Frontend production build đạt, 160 modules; backend syntax checks và `git diff --check` đạt.
- Smoke test trên VM dùng Redis container tạm riêng: worker ảnh thực tế khởi động/dừng thành công; queue thử enqueue, xử lý, nhận kết quả và xóa job thành công. Queue ảnh để rỗng; không gửi ảnh hay truy vấn PostgreSQL. Container Redis tạm được xóa sau test.
- Đây là kiểm tra nền queue; chưa phải kiểm thử end-to-end ảnh qua Python/MinIO/PostgreSQL. Các giới hạn retry/partial/reconcile và pipeline bitmap cũ đã được ghi rõ tại P2.

Phần 7 là kết quả bước chuẩn bị trước triển khai. Luồng RAW + overlay đã được thực hiện trên `feature/image-storage-optimization`; xem báo cáo implementation để biết kết quả mới nhất. Migration 011, chuyển đổi annotations lịch sử và GC chưa được chạy trên DB/bucket dùng chung.
