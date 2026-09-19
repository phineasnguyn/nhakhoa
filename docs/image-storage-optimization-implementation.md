# Triển khai tối ưu lưu trữ ảnh

Cập nhật 20/09/2026. Branch duy nhất: `feature/image-storage-optimization`. Đã hợp nhất toàn bộ lịch sử triển khai từ nhánh gõ thiếu chữ `a`; không tạo một feature tối ưu ảnh thứ hai.

## 1. Kết quả và phạm vi

Luồng Process/Reprocess dùng một bitmap RAW đang hoạt động. Python nhận bbox/ID/kích thước qua JSON và trả bốn vùng; backend lưu vào PostgreSQL, frontend ghép ảnh nguồn với lớp SVG. Luồng này không upload bitmap processed, không tạo ZIP và không sinh prediction ngẫu nhiên. RAW và overlay có cùng URL cache; sửa nhãn không tăng revision ảnh.

Ảnh cũ tiếp tục có `url_processed` để fallback. Chỉ ảnh đạt kiểm tra hình học/revision mới trả `render_mode=overlay`; ảnh thiếu dữ liệu trả `review_required`, job nhiều ảnh có thể `partial`. Chưa thu hồi dung lượng của các bitmap lịch sử. Công cụ P4 chỉ tạo manifest kiểm kê; P5 (bỏ tham chiếu/xóa object) chưa thực hiện và không được chạy ngầm bởi migration/worker ảnh.

Nền `feature/delete-patient` tại `2885562` đã được merge nguyên lịch sử bằng `685e8f1`. Khi fetch lại, upstream `dev` đã có PR #5 tại `cbaf894`; merge vào nhánh bằng `6cabecb` không conflict. Đây là kết quả với các commit hiện tại, không bảo đảm mọi thay đổi tương lai đều tự merge.

## 2. Thay đổi chính

| Phần | Hành vi mới |
| --- | --- |
| Migration 011 | Thêm revision ảnh/annotations, schema overlay, lý do review, xác nhận empty input và lịch sử nguồn. Trigger tăng revision cả khi import/legacy writer sửa annotations. |
| Python `/api/process/overlay-metadata` | Tính ở tọa độ ảnh gốc theo parent annotation ID; từ chối bbox sai, không mắc cài, nhiều mắc cài hoặc vùng diện tích không hợp lệ. |
| `imageOverlayService` | Snapshot nhất quán, kiểm tra revision trước commit; chỉ thêm nhóm vùng còn thiếu, giữ nguyên ID/nhãn/history của nhóm hợp lệ đã tồn tại. Không delete/reinsert nhãn bác sĩ/YOLO. |
| BullMQ | Giữ nền queue/delete-patient. Job ID Redis là `image-<DB id>` vì BullMQ 5.80.9 từ chối custom ID chỉ gồm số; payload có `processingJobId`. Polling theo đúng DB job ID, phân biệt retry/partial/review, có timeout và cancel. Reconciler phục hồi job tạo dở hoặc đồng bộ kết quả queue. |
| Viewer | Grid và lightbox dùng IMG + SVG cùng hệ tọa độ; legacy bitmap không bị vẽ overlay hai lần. Lỗi tải annotations không hiển thị RAW như kết quả hoàn tất. |
| Proxy | Stream MinIO với backpressure, ETag và `If-None-Match` → 304; không tải toàn ảnh vào buffer cho mỗi GET. Cache private 1 giờ, không dùng `immutable` vì còn writer cũ. |
| Rotation | Backend xoay nguồn gốc theo góc 90/180/270, tạo object revision mới rồi CAS DB; transform mọi bbox và vùng canonical, giữ ID/nhãn/history. Giữ nguồn cũ trong history. Nếu mất phản hồi COMMIT, không xóa object có thể đã được tham chiếu. |
| Export | Dùng RAW hiện tại và bbox sau xoay; COCO hiểu plaque số 0/1; chuẩn hóa object key bằng helper storage thay vì hard-code bucket. Không đổi quy ước import YOLO. |
| Cleanup kế thừa | Kiểm tra object chia sẻ tính cả `image_source_history`, tránh xóa nguồn/bitmap còn được history tham chiếu. |

Quy ước mới là `top/bottom/left/right` theo ảnh; không suy diễn G/I/M/D. Vùng cũ `top_left/...` và nhãn đi theo ID được giữ. Giá trị mặc định `plaque_status=1` kế thừa quy ước cũ, `annotated_by=NULL` vẫn là chưa được bác sĩ xác nhận; prediction mới là NULL.

Khi xoay, các tên vùng canonical được tạm đặt NULL rồi gán lại trong cùng transaction để không va unique index hiện có. Snapshot history giữ cả ảnh và annotations trước xoay. Rollback về phiên bản ứng dụng rất cũ không tự đọc được ảnh overlay mới; cần bản ứng dụng tương thích hoặc dựng lại bitmap từ nguồn và metadata.

## 3. Môi trường VM và dữ liệu

- Workspace code: `/home/dev_phien/nhakhoa` trên `dev-vm-02`, `192.168.1.151`.
- Root có screen `909920.backend`, `910258.frontend`; tiến trình Node/Vite của chúng chạy từ `/projects/nhakhoa`. Không đổi code hay restart các screen đó.
- Theo hướng dẫn người dùng, DB dev là cụm Patroni 155–157. REST báo 155 primary, 156/157 replica; SQL read-only xác nhận `inet_server_addr=192.168.1.155`, `current_database=dental_db`, `pg_is_in_recovery=false`.
- Đã sửa cấu hình riêng `backend/.env` và `.env.db` về `192.168.1.155:5432/dental_db`, đồng bộ credential đã kiểm chứng. File được sao lưu ở thư mục tạm quyền riêng trên VM; credential không ghi trong docs/Git. Đã kiểm tra SHA256 cho thấy `frontend/vite.config.js`, `compose.dev.yml`, `compose.db-external.yml` giữ nguyên.
- PostgreSQL standalone trên 151 phục vụ demo của nhóm; không dùng nó để migrate hoặc tạo/xóa fixture. Không restart MinIO/Redis/Python hiện hữu.
- DB cluster tại lần kiểm tra vẫn chưa có `storage_deletion_jobs`. Không khởi động worker mới trên cluster khi chưa áp dụng schema tương ứng. Không chạy migration 011 trên cluster trong lượt triển khai code này.

155 là primary tại thời điểm kiểm tra, không phải endpoint tự failover. Trước khi chạy app/migration cần xác nhận writer endpoint hiện hành của Patroni; dùng VIP/proxy của cụm nếu hạ tầng đã cung cấp.

## 4. Kiểm thử và cách chạy lại

Backend unit tests: `cd backend && npm run test:unit` (25/25 đạt, cùng subboxMapper). Python: `cd image-processing-service && python3 -m unittest discover -s tests -p test_overlay_geometry.py` (4/4 đạt). Frontend: `cd frontend && npm run build` (161 modules). `git diff --check` đạt.

Trên VM có Docker và Node dependencies, chạy từ root repo:

```sh
python3 scripts/test-image-overlay-isolated.py
```

Runner tạo bốn container tên `overlay-test-<random>-*`, port ngẫu nhiên bind loopback, DB/bucket riêng, không nạp `.env`. PostgreSQL test không phải instance demo. Runner dùng các Docker image sẵn có (Python image `nhakhoa-dev-image-processor:latest` với source bind read-only), áp dụng schema 002–011 bỏ seed demo; 001 là script provisioning cũ có cú pháp không hợp lệ với PostgreSQL vanilla và không được dùng. Cuối test chỉ dọn container/volume do chính runner tạo.

Các assertion tích hợp gồm:

- Migration 011 trên DB mới, chạy lại và chạy lại sau khi có overlay không đổi dữ liệu.
- Process/reprocess không thêm object; fixture 2 object / 3.386 byte vẫn là 2 object sau xử lý metadata. Đây là fixture chức năng, không phải benchmark dữ liệu thật.
- Giữ ID/nhãn khi reprocess; stale annotation revision bị từ chối trước insert.
- Xoay 90/180/270 giữ ID/nhãn/annotated_by/annotation_history, cập nhật dimensions và giữ 3 snapshot nguồn.
- Worker thật với Redis/Python/PostgreSQL: một ảnh hợp lệ + một ảnh thiếu input → partial; một lỗi Python giả lập → retry và hoàn tất partial, không mất job.
- Reconcile đồng bộ lại trạng thái từ job đã completed; Redis job JSON dưới 10 KB, không chứa bitmap.
- Manifest gộp object trùng và giữ object còn consumer legacy/history.
- Export COCO/YOLO tạo ZIP thật từ MinIO fixture; nhãn 0/1 được giữ, NULL không xuất thành class âm tính; byte ảnh trong ZIP khớp nguồn RAW sau xoay.

Kiểm tra trực quan trên fixture tổng hợp bằng component viewer thật: RAW/processed, grid/lightbox, đổi nhãn và preview xoay 90°. Cả grid và lightbox giữ URL `/api/images/proxy/tmp/fixture.jpg?v=1` khi đổi nhãn; ảnh và các rect xoay đồng bộ. Fixture trình duyệt mock API; assertion service thật nằm ở test tích hợp, không coi preview là kiểm thử HTTP xác thực hoàn chỉnh.

Không có số đo RAM browser/Python trước–sau trên ảnh bệnh nhân. RSS Node fixture sau cả export khoảng 117 MiB là số đo tại một thời điểm. Không kết luận giảm 50% Redis: queue nền vốn đã lưu metadata thay vì binary ảnh.

## 5. Chuyển đổi và kiểm kê trước GC

1. Kiểm tra writer endpoint Patroni, backup DB/bucket và mọi ứng dụng có quyền ghi chung. Áp dụng các migration còn thiếu 008–010 từ delete-patient, rồi 011 trong cửa sổ triển khai phù hợp; không giả định thêm file init tự migrate volume cũ.
2. Triển khai Python metadata endpoint trước backend/frontend mới. Giữ legacy bitmap. Chọn visit thử đã đối chiếu nguồn ảnh–bbox, dùng Process để chuyển theo từng ảnh; xem kết quả partial/review, không chuyển hàng loạt nhóm thiếu dữ liệu.
3. Xác minh overlay trực quan và nhãn/history, chạy kiểm kê chỉ đọc với cấu hình DB/bucket được cung cấp rõ ràng:

```sh
# Chạy trong backend; biến DB_*/MINIO_* phải được nạp từ cấu hình đúng môi trường.
node scripts/audit-image-storage.js --out /private/path/review.manifest.json
```

CLI không tự đọc `.env`, không ghi DB, không xóa MinIO, không ghi đè manifest có sẵn. Manifest chứa identity DB/bucket, object key, size/ETag/version, ảnh/revision/tham chiếu và lý do phải giữ. File manifest có tham chiếu nhạy cảm nên lưu riêng, không commit (`*.manifest.json` đã ignore). `candidateBytes` chỉ là tiềm năng cần review, không phải byte đã thu hồi.

4. P5 là thao tác vận hành chưa mở: phải xác định đầy đủ consumer dùng chung bucket, hết thời gian giữ rollback, backup đã xác minh và dừng/drain writer. Trước mỗi lần bỏ tham chiếu/xóa cần kiểm tra lại revisions, mọi tham chiếu (kể cả soft-delete/history), ETag và bucket versioning; giữ checkpoint để retry. Công cụ hiện tại cố ý không có `--apply`; không sử dụng manifest một lần đọc làm lệnh xóa tự động. Không xóa prefix để thu hồi bitmap cũ.

Ảnh legacy thiếu annotations vẫn xem được bitmap. Kết quả empty chỉ được xác nhận khi có căn cứ, không tự đặt `annotations_verified_empty=true`. Giữ cả phiên bản nguồn cũ sau xoay có thể tăng dung lượng tạm cho rollback; đây không phải bitmap overlay trùng.
