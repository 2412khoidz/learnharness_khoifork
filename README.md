<p align="center">
  <img src="build/icon-flat.svg" alt="ChronoHarness" width="84">
</p>

<h1 align="center">ChronoHarness (LearnHarness Fork)</h1>

<p align="center">
  <strong>Agent harness cho việc học sâu — mở rộng thêm Exam Mode theo môn, vòng lặp khép kín FSRS-6 ↔ Knowledge Graph ↔ Practice, Mobile Study Companion qua QR và bộ công cụ ôn tập tốc độ cao.</strong>
</p>

<p align="center">
  <a href="https://github.com/2412khoidz/learnharness_khoifork/releases/latest">Tải bản Windows mới nhất</a> ·
  <a href="#tất-cả-điểm-mới-so-với-learnharness-gốc">Khác biệt so với bản gốc</a> ·
  <a href="#hướng-dẫn-sử-dụng-nhanh">Hướng dẫn nhanh</a> ·
  <a href="#nền-tảng-learnharness-gốc">Nền tảng sư phạm</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness">Upstream LearnHarness</a>
</p>

---

**ChronoHarness** (`2412khoidz/learnharness_khoifork`) là nhánh mở rộng từ [**LearnHarness v0.6.1**](https://github.com/amosblomqvist/learnharness), giữ nguyên trọn vẹn phương pháp sư phạm *Measure → Plan → Teach → Practice* nhưng **cài đặt & chạy song song hoàn toàn độc lập** trên Windows và bổ sung loạt tính năng phục vụ ôn thi cường độ cao, theo dõi trí nhớ dài hạn bằng FSRS-6 và học liên thiết bị trên điện thoại.

> **Bản phát hành Windows x64 mới nhất:** [`ChronoHarness-0.6.1-x64-setup.exe` (`chronoharness-0.6.1-r7`)](https://github.com/2412khoidz/learnharness_khoifork/releases/tag/chronoharness-0.6.1-r7)
> - SHA256: `d1825e706d61b40b0bf0eea40057c314b7f28ef3ddedf0c7f9374deb26203c17`

![LearnHarness teaching session](docs/assets/teaching-session.png)

---

## Tất cả điểm mới so với LearnHarness gốc

Bảng đối chiếu nhanh giữa **LearnHarness `v0.6.1` gốc** và **ChronoHarness (`learnharness_khoifork`)**:

| Hạng mục | LearnHarness `v0.6.1` gốc | ChronoHarness (Fork này) |
|---|---|---|
| **Cài đặt trên Windows** | `LearnHarness`, lưu ở `%APPDATA%\LearnHarness` | **Tách riêng `ChronoHarness`** (`com.chronoharness.desktop`), `%APPDATA%\ChronoHarness\data\`, NSIS/GUID cô lập — chạy song song được với bản gốc |
| **Chế độ học & Nhịp dạy** | Một chế độ dạy mặc định duy nhất | **`Long-Term` / `Exam Prep`** + **3 nhịp dạy (`Thorough` / `Efficient` / `Crash`)** + **lọc theo môn (`Subject Scope`)** + **lưu tối đa 30 hồ sơ kỳ thi (`Saved Exams`)** |
| **Liên kết Graph ↔ FSRS-6 ↔ Practice** | Graph chỉ lưu khái niệm; Practice độc lập với Flashcards | **Bản đồ nhiệt FSRS-6 trên Graph**, `Readiness %` có trọng số, nút **`Practice weak`** & **`Drill`**, tự **chấm ngược FSRS** khi `conclude` Practice + **1-day recheck**, **FSRS-6 Optimizer** & **Fuzz** |
| **Sổ tay lỗi sai & Phân tích AI** | Chỉ hiển thị đúng/sai & giải thích tĩnh trong phiên chat | **Trang `/mistakes`** gom mọi câu sai (kể cả **Free recall** `explain`/`recall` qua AI `flag_mistake` hoặc nút **`Save to mistakes`**) / `"I don't know"` / bài Practice chưa giải gọn, **phân loại 9 nhóm lỗi**, tự động phân tích ngắn nguyên nhân + **"Next time" rule** ngay dưới nút **`Why`**, tool `mistakes` cho AI và tự nhắc trong **Exam Prep** |
| **Nhận biết khoảng nghỉ học** | Không theo dõi thời gian gián đoạn giữa các lượt | **Temporal Gap Hints** tự gắn ghi chú tạm sau `>= 4 giờ` / `>= 24 giờ` nghỉ trên payload gửi model |
| **Học trên điện thoại (QR)** | Không có | **Mobile Study Companion v2** qua `Same Wi-Fi (LAN)` hoặc `Any network (HTTPS)` (Cloudflare Quick Tunnel pre-warm, chạy nền 60m): tab **`Photo`**, **`FSRS Cards`**, **`Exam & Chat`** (kèm **`📷 Camera`** & **`📎 Attach File`** trong chat) |
| **Ghi chú, Toán & Sửa tin nhắn** | Chỉ trích dẫn vào câu hỏi hoặc chat phụ | **Sổ tay từng bài (`Notes`)** kéo rộng `280–560px`, bôi đen **`Note`** để trích dẫn, **click công thức toán copy LaTeX**, **`Edit Last`** tua ngược lượt cuối, **Pin/Archive** session, **dán ảnh Ctrl+V** |
| **Nhập sách & Ngôn ngữ Graph** | Không có `.epub`, trích xuất hay bị đổi sang tiếng Anh | Nhập **`.epub`** (≤ 25 MB) kèm **`[DOCUMENT OUTLINE DIGEST]`**, giữ ngôn ngữ nguồn (**`Extraction language`**), sửa bare LaTeX & đóng gói KaTeX standalone |
| **Sao lưu toàn bộ dữ liệu** | Sao chép thủ công thư mục `data/` | **1-Click `Backup & Restore`** ra file `.json` (kèm `mistakes.json`, không xuất `auth.json` / API keys) |
| **Model & Hiệu năng** | Catalog tĩnh `pi-ai 1.4.0` | **Pi `1.5.2`**, thêm **`gemini-4-hydrogen` / `gemini-4-carbon`**, **Live Model Discovery** (Google/OpenRouter + Copilot dynamic), **`+ Add model ID`**, **`Pause <provider>`**, **Virtual Transcript**, sửa ngân sách **Researcher** |

Chi tiết từng nhóm nâng cấp so với bản gốc:

### 1. Cài đặt & Chạy song song Độc lập (`Side-by-Side`)
- **Định danh & bộ cài riêng:** Tên ứng dụng `ChronoHarness`, icon đồng hồ cát riêng (`build/icon-flat.svg`), `appId: com.chronoharness.desktop`, cấu hình NSIS (`build/installer.nsh`) tách `APP_FILENAME` và updater (`chronoharness-updater\installer.exe`) khỏi bản LearnHarness chính thức.
- **Thư mục dữ liệu riêng:**
  - **ChronoHarness:** `%APPDATA%\ChronoHarness\data\`
  - **LearnHarness gốc:** `%APPDATA%\LearnHarness\data\`
- **Cài đặt cùng lúc:** Bạn có thể giữ cả LearnHarness gốc lẫn ChronoHarness trên cùng một máy Windows và mở cả hai song song mà không ghi đè dữ liệu hay xung đột single-instance lock.

### 2. Study Mode, Exam Prep theo môn & 3 Nhịp dạy (`ChronoHarness` Sidebar)
- **Thẻ `ChronoHarness` thu gọn 1 chạm (`▴` / `▾`):** Nằm gọn ở đầu Sidebar trái (`components/exam-prep-bar.tsx`); có thể bấm thu gọn thành **1 dòng duy nhất** (vẫn giữ tên kỳ thi, đếm ngược `D-x` và `Readiness %`) để nhường chỗ cho danh sách `Sessions`.
- **Chỉ số `Readiness %` có trọng số FSRS-6 (`src/core/fsrs-graph.ts`):**
  - Tự tính theo phạm vi đang chọn (hoặc toàn đồ thị khi ở `All subjects`).
  - Node nền tảng (`dependentCount >= 1`) mang trọng số **`2`**, node lá mang trọng số **`1`**.
  - Điểm từng node: chưa tạo thẻ (`untracked`) = `0.35`, thẻ mới (`new`) = `0.50`, đang ôn chưa đến hạn = `R`, đã đến hạn (`due`) = `0.6 × R`.
- **Lọc phạm vi môn học (`Subject Scope`):** Tích chọn **1 hoặc nhiều cụm chủ đề** từ Knowledge Graph (`clusterIds`), bấm `Done` để lọc hoặc `All` để trở về toàn đồ thị.
- **Công tắc Chế độ (`Study Mode`):**
  - `Long-Term`: Học hiểu sâu để ghi nhớ bền vững dài hạn.
  - `Exam Prep`: Mở thêm bộ quản lý kỳ thi (`Saved Exams`), tên kỳ thi, đếm ngược ngày thi (`D-x` / `Today` / `+Nd`) và nút **`Drill`**.
- **3 mức Nhịp dạy theo từng vai trò (`Study Pace` cho `Prober` / `Teacher` / `Practice`):**
  - `Thorough`: Dò rộng mặt bằng (`Prober`), dẫn xuất & chứng minh đầy đủ (`Teacher`), giữ nguyên Socratic nudging sâu (`Practice`).
  - `Efficient`: `Prober` giảm khoảng một nửa số câu hỏi dò dư thừa; `Teacher` cân bằng trực giác & chứng minh cốt lõi, **tin ngay câu trả lời đúng tự làm** (không hỏi dò xác nhận thừa trừ khi cần gợi ý); `Practice` trả lời ngắn gọn theo lỗi đầu tiên và nếu kẹt cùng một chỗ qua 2 lần gợi ý sẽ chốt bước thiếu rồi `movedOn` (`retest: true`).
  - `Crash`: Tối đa điểm thi/phút — `Prober` chỉ hỏi ~2–4 câu cốt lõi; `Teacher` dạy theo mẫu (ý chính → quy trình giải → dấu hiệu nhận biết khi nào dùng) + 1 câu kiểm tra mỗi bước; `Practice` ưu tiên đề thi/chuyển giao trên nền tảng yếu/đến hạn và chốt nhanh khi kẹt quá 2 lượt gợi ý.
- **Hồ sơ nhiều kỳ thi (`Saved Exams`):** Tạo và lưu tối đa **30 hồ sơ thi** riêng biệt (`+ New`, `Edit`, `Delete`, `Choose subject`, dropdown đổi nhanh); mỗi hồ sơ giữ **Tên kỳ thi**, **Ngày thi**, **Pace** và **Cụm môn** riêng.
- **Nút `Drill` & Nhắc ôn ưu tiên:** Thẻ tóm tắt ngay `Weak` và `Due (N)`. Bấm **`Drill`** mở thẳng màn hình tạo phiên **Practice** (`/chat/new?mode=practice&drill=1`) đã nạp sẵn tối đa **8** mệnh đề ưu tiên (lấy từ tối đa `12` mục trong `priorityPropositionIds`) cùng gợi ý prompt ôn thi.
- **Cơ chế hoạt động & mặc định nguyên bản:**
  - Ở mỗi lượt chat trong **Prober**, **Teacher** và **Practice**, server đọc cấu hình hiện tại và chèn khối **`[ChronoHarness Study Mode Directive]`** tách riêng cho từng vai trò vào **cuối** `systemPrompt` để giữ tối đa **prefix prompt caching** (`src/agent/teacher-agent.ts`, `src/core/exam-prep.ts`).
  - Khối directive bị **giới hạn cứng** tối đa **6** `Weak Foundations` + **8** `Due/Decaying Propositions` + **6** `Untracked Foundations` (+ tối đa **3** quy tắc từ Sổ tay lỗi sai khi có), giữ phần đuôi prompt rất gọn và ổn định.
  - **Mặc định giống LearnHarness gốc:** Khi đặt ở `Long-Term` + `Thorough` + `All subjects` (không lọc cụm môn), ChronoHarness **không chèn** directive (`promptDirective = null`), giữ nguyên 100% hành vi gốc.
  - **`Side question`** (hỏi nhanh khi bôi đen văn bản) đi qua luồng `src/agent/side-chat.ts` riêng và chọn model theo thứ tự: `agent.models.sideQuestion` → model của session hiện tại → slot `Strong`.

### 3. Đồ thị Tri thức ↔ FSRS-6 ↔ Vòng lặp Practice & Optimizer
- **Bản đồ nhiệt FSRS-6 trên Graph (`components/graph-view.tsx`):**
  - Thanh công cụ lọc trên Đồ thị hiển thị số node **Strong / Decaying / Overdue**, chip **`FSRS`**, **`Due (N)`**, **`Foundations (N · X untracked)`**, **`Prereq (N)`** (cảnh báo node có tiền đề yếu), **`Off`**, và nút **`Practice weak`**.
  - Bấm **`Practice weak`** (hoặc **`Select for Practice`** trên thẻ node) nạp toàn bộ các node yếu/đến hạn/tiền đề yếu và chuyển thẳng thanh soạn chat ở màn hình Graph/Home sang chế độ **Practice** (kèm nút **`Start Practice →`**).
  - Click từng node trên Graph để xem trực tiếp chỉ số **`R=% · S=..d · D=..`**, số mệnh đề phụ thuộc phía sau (`Supports N downstream propositions`), trạng thái `Untracked foundation` và danh sách `Weak prerequisites`.
- **Chấm điểm ngược tự động từ Practice → FSRS-6 (`src/server/graph-fsrs.ts`):**
  - Khi AI gọi tool `conclude` chốt một bài tập Practice (ngoại trừ `dismissed` và `movedOn`), server tự tính rating FSRS (`1`–`4`) theo `outcome`, `rung`, `missClass`, `reps`, `stability` và ghi thẳng vào `flashcards.json` cho mọi target đã có cue.
  - **Bảo vệ `1-day recheck`:** Với kiến thức đã bền (`stability >= 7` khi `solvedWithHints` hoặc `stability >= 10` khi `surrendered`, và `lapses === 0`), thay vì reset lịch dài hạn về `Again`, hệ thống chấm `Hard` và hẹn kiểm tra lại đúng sau **1 ngày**.
- **Lưu ý để AI nhận diện FSRS đầy đủ:** ChronoHarness đọc `flashcards.json` tự động, nhưng bản thân app **không tự động sinh flashcard** khi extract Graph (`plugins/flashcards/README.md`). Hãy vào mục **`FLASHCARDS`** chọn các chủ đề/node để tạo cue (hoặc tạo tay bằng `+ Create card`) để các node thoát khỏi trạng thái `untracked` và tham gia vòng lặp FSRS.
- **FSRS-6 Personal Parameter Optimizer & Load-balancing Fuzz (`plugins/flashcards`):**
  - Cá nhân hóa 21 trọng số FSRS-6 dựa trên lịch sử ôn tập của chính bạn (yêu cầu tối thiểu **30 reviews** và **10** chuyển đổi nhiều ngày), kèm nút `Reset default weights`.
  - Tùy chọn **Load-balancing fuzz** giãn đều các khoảng lặp lại `>= 3 ngày` tránh dồn thẻ vào cùng một ngày.
- **Temporal Gap Hints (`src/core/native-messages.ts`):** Khi quay lại một session cũ sau **`>= 4 giờ`** hoặc **`>= 24 giờ`**, app tự ghép `[Temporal note: ... elapsed since the previous turn in this session...]` lên payload gửi model (không làm bẩn file lịch sử chat lưu trên đĩa).

### 4. Mobile Study Companion v2 (Quét QR — LAN & Mọi mạng 4G/5G/Wi-Fi)
- **Hai chế độ mạng (`components/phone-upload-button.tsx`, `src/server/phone-upload.ts`):**
  - **`Same Wi-Fi (LAN)`:** Kết nối trực tiếp qua mạng nội bộ.
  - **`Any network (HTTPS)`:** Dùng Cloudflare Quick Tunnel (`trycloudflare.com`) được **pre-warm sẵn** để truy cập từ 4G/5G hoặc Wi-Fi khác mạng.
- **Chạy nền bền bỉ sau khi đóng bảng QR:** Bấm `Done` hoặc `X` chỉ ẩn modal QR — kết nối điện thoại vẫn chạy nền (idle TTL **60 phút**, tự gia hạn khi có thao tác) kèm chấm xanh trạng thái trên nút điện thoại, **không** bị mất kết nối hay lỗi `HTTP 404`. Chỉ ngắt khi bấm **`Disconnect`** hoặc tạo lại mã bằng **`New code`**.
- **3 tab tối ưu trực tiếp cho điện thoại (`src/server/phone-mobile-ui.ts`):**
  1. **`Photo`:** Chụp ảnh camera (`Take Photo with Camera`) hoặc chọn nhiều ảnh gửi thẳng vào ô soạn thảo Desktop; có tùy chọn **`High detail (2400px · slower over 4G/5G)`**.
  2. **`FSRS Cards`:** Ôn thẻ FSRS-6 đến hạn ngay trên điện thoại (`Show Answer` → `Again` / `Hard` / `Good` / `Easy` kèm ngày hẹn dự kiến), lưu thẳng vào `flashcards.json`.
  3. **`Exam & Chat`:**
     - Điều chỉnh **`Study Mode`**, **`Teaching Pace`**, **`Subject Scope`**, **`Saved Exams`** và theo dõi **`Readiness %`**.
     - Mở danh sách **`Recent Sessions`**, đọc bài có công thức **KaTeX**, gửi câu trả lời quiz/giải thích (`Tutor Check`, `Submit Selected`, `I don't know`), hoặc tạo mới **`Teach Me` / `Practice Problems` / `Drill Weak Roots`**.
     - Chỉnh sửa **`Per-Lesson Notes`** đồng bộ hai chiều với máy tính.
     - **`📷 Camera` & `📎 Attach File` ngay trong khung Chat:** Chụp trực tiếp ảnh bài làm viết tay hoặc đính kèm nhiều tài liệu (ảnh, `.pdf`, `.txt`, `.md`, `.tex`, code... tới **25 MB/file**) ngay lúc trả lời AI Tutor hoặc khi tạo bài học mới qua endpoint `/p/<token>/companion/upload`.

### 5. Công cụ Học tập, Trích xuất Tài liệu, Toán LaTeX & Sao lưu
- **Sổ tay bài học (`Notes` — `components/lesson-notes-panel.tsx`):** Nút **`Notes`** góc trên bên phải mỗi session mở khung ghi chú Markdown, kéo giãn **`280px–560px`** (mặc định `340px`), tự lưu sau `500ms`, có nút **Copy Markdown**, **Download `.md`**, đồng bộ với Mobile Companion.
- **Bôi đen trích dẫn (`Quote while you read`):** Bôi đen đoạn text bất kỳ trong bài giảng và bấm **`Note`** để chèn thẳng trích dẫn vào Lesson Notes.
- **Click công thức toán copy mã LaTeX (`components/chat.tsx`):** Nhấp chuột trực tiếp vào công thức `.katex` bất kỳ (khi không bôi đen chữ) để copy nguyên mã LaTeX gốc vào clipboard (`Copied LaTeX: ...`).
- **Tua ngược & Sửa tin nhắn cuối (`Edit Last`):** Hoàn tác lượt hỏi/đáp gần nhất và đưa lại câu hỏi cũ vào ô soạn thảo để chỉnh sửa rồi gửi lại.
- **Ghim & Lưu trữ Session (`components/sidebar.tsx`):** Hỗ trợ **`Pin to Top` / `Unpin`** và **`Archive` / `Unarchive`** từng session cùng nút chuyển xem **`Archived (N)`** ↔ **`Back to Active Sessions`**.
- **Nhập sách `.epub` & `[DOCUMENT OUTLINE DIGEST]` (`src/server/epub-import.ts`):** `Extract files…` hỗ trợ thêm **`.epub`** (giới hạn `25 MB/file` như PDF/Markdown/TeX). Tài liệu **`>= 12,000` ký tự** phát hiện được từ `2` tiêu đề trở lên tự động được gắn khối **`[DOCUMENT OUTLINE DIGEST]`** (tối đa `25` tiêu đề + ước lượng số từ) ở đầu trước khi tách chunk để giữ bối cảnh chương sách.
- **Dán ảnh trực tiếp từ Clipboard (`Ctrl+V`):** Dán ảnh chụp màn hình hoặc ảnh sao chép thẳng vào ô chat (`components/path-input.tsx`).
- **Giữ nguyên ngôn ngữ nguồn & sửa Toán/LaTeX:**
  - Mục **`Extraction language`** trong Settings (`src/core/output-language.ts`, mặc định `Auto (match session/notes)`, hỗ trợ `Tiếng Việt`, `English`, `日本語`, `中文`, `한국어`, `Français`, `Deutsch`, `Español`) giúp Graph & Flashcards không bị tự dịch sang tiếng Anh khi bạn học bằng tiếng Việt.
  - Sửa lỗi delimiter toán (`src/core/math-delims.ts`), phục hồi bare LaTeX cho node Graph cũ (`src/core/bare-math.ts`) & Flashcards (`plain-math.js`), và đóng gói đầy đủ font/CSS KaTeX trong `scripts/build-server.mjs`.
- **Sao lưu & Khôi phục 1-Click (`Settings → General → Backup & Restore`, `src/server/backup.ts`):**
  - `Export snapshot` tải file `kronoharness-backup-YYYY-MM-DD.json` (`kronoharness-backup-v1`) chứa Knowledge Graph, toàn bộ Chats, Flashcards FSRS-6 + sources, `mistakes.json`, `exam-prep.json`, `settings.json`, `live-models-cache.json` (**không** bao gồm `auth.json` / API keys).
  - `Restore snapshot` khôi phục toàn bộ dữ liệu học tập từ file JSON đó khi cài lại Windows hoặc chuyển máy.

### 6. Sổ tay Lỗi sai & Phân tích Nguyên nhân AI (`/mistakes` — port từ `vvcdev/learnharness` via `amoghu1s1/twig`)
- **Tự động ghi nhận (`src/core/mistakes.ts`, `src/store/mistakes.ts`, `src/agent/tools/flag-mistake.ts`):** Mọi câu quiz sai (`quiz`, `probe`, `mcq`, `mcq_batch` — bỏ qua trả lời giọng nói `byVoice` chưa chấm), bấm `"I don't know"`, bài tập **Practice** kết thúc chưa trọn vẹn (`Solved, but needed hints` / `Moved on without solving` / `Gave up`), **và cả câu trả lời tự luận Free recall (`explain` / `recall`) bị sai, thiếu ý hoặc trả lời không biết** (AI tự gắn cờ `flag_mistake` ngay trong lượt chấm mà không tốn lượt gọi thừa khi trả lời đúng, kèm nút bấm 1 chạm **`Save to mistakes`** ngay trên thẻ để lưu thủ công bất kỳ lúc nào) được lưu vào `data/mistakes.json` và tự phân tích sau mỗi lượt hoàn tất (`mistakesAfterTurn`).
- **Phân tích nguyên nhân & Rule rút kinh nghiệm (`src/server/mistake-analysis.ts`):** Model ở slot **`Cheap`** (role `analyst`) phân loại lỗi theo **9 nhóm** (`Knowledge gap`, `Confusable pair`, `Reversal`, `Setup error`, `Calculation slip`, `Misread`, `Incomplete reasoning`, `Wrong situation`, `Code or logic bug`), chỉ rõ **`What happened`**, **`What’s correct`** (dùng đúng số liệu bài làm) và quy tắc **`Remember this`** (hiển thị kèm nhãn **`Next time:`** dưới nút **`Why`**). Có thể bật/tắt tự động phân tích và giới hạn ngân sách (`1–100` lần/24h trượt, mặc định `20`) trong **Settings → Agent → Tools (`Mistake analysis` & `Daily analysis limit`)**. *(Lưu ý: nếu tắt tự động phân tích, hệ thống cũng bỏ qua bước tự ghi lỗi sau mỗi lượt; có thể vào `/mistakes` bấm **`Scan past sessions`** để quét bù bất cứ lúc nào.)*
- **Hiển thị ngay trong bài học & trang riêng `/mistakes`:**
  - Nút **`Mistakes`** nằm gọn dưới chân Sidebar trái (bên cạnh `Settings`, không chiếm diện tích danh sách Sessions). Hỗ trợ nhóm theo **`Error type` / `Session` / `Topic`** (tự chỉ ra pattern lặp lại), lọc tìm kiếm, quét bù toàn bộ lịch sử cũ (**`Scan past sessions`** → **`Analyze them`**), **`Expand all` / `Collapse all`**, **`Retry analysis`**, **`Cancel`** và xóa từng mục. *(Trường `sources` được giữ rỗng `[]` để tương thích cấu trúc vì ChronoHarness không dùng "lesson sources" theo thư mục gắn session như fork gốc.)*
  - Bấm **`Why`** trên từng thẻ câu trả lời sai (hoặc thẻ **Explain / Recall** đã lưu) trong chat để mở ngay phần phân tích lỗi & rule **`Next time`**. Thẻ **Explain / Recall** chưa lưu còn có nút **`Save to mistakes`** ngay dưới đáp án mẫu để lưu nhanh & kích hoạt phân tích qua `POST /api/chats/[id]/mistakes`.
- **Tích hợp với Tutor, Exam Prep & Backup:**
  - AI `Teacher` có tool chỉ đọc native **`mistakes`** (`src/agent/tools/mistakes.ts`) với `list`, `summary`, `get` để tra cứu lỗi cũ khi sửa bài.
  - Khi bật chế độ khác mặc định (**`Exam Prep`**, **`Efficient`**, **`Crash`**, hoặc **`Subject Scope`**), directive gửi model tự đính kèm tổng số lỗi, pattern lặp lại nhiều nhất và tối đa **3** quy tắc **`Next time`** gần nhất (vẫn giữ mặc định `Long-Term + Thorough` hoàn toàn không tốn token thêm).
  - **`Backup & Restore`** tự động đóng gói và khôi phục luôn `mistakes.json` (hiển thị `mistakesCount` khi khôi phục).

### 7. Model, Provider, Hiệu năng & GitHub Actions Workflows
- **Nâng cấp runtime `@earendil-works/pi-ai` & `@earendil-works/pi-agent-core` lên `1.5.2`** (upstream v0.6.1 dùng `1.4.0`).
- **Live Model Discovery & Supplemental Catalog (`src/agent/live-models.ts`, `electron/subscriptions.cjs`, `components/model-picker.tsx`):**
  - Bổ sung sẵn **`gemini-4-hydrogen`** và **`gemini-4-carbon`** (Google, Google Vertex, GitHub Copilot).
  - Tự dò model mới từ endpoint `/models` của **Google** và **OpenRouter** (cache 5 phút, lưu bền vào `live-models-cache.json`) và tổng hợp model mới từ danh sách khả dụng của **GitHub Copilot** (`gpt-5*`, `gpt-6*`, `gpt-7*`, `grok-*`, `mai-*`, `claude-*`, `o1/o3/o4`).
  - Thêm nút **`+ Add model ID`** (nhập tay model mới theo từng provider) và **`Pause <provider>`** (ẩn tạm provider khỏi picker mà không xóa API key).
- **Tăng tốc Chat dài & Sửa lỗi Researcher:**
  - Virtualize transcript dài bằng `@tanstack/react-virtual` (`components/virtual-transcript.tsx`), lazy-load Mermaid, cache danh sách chat (`src/store/chats.ts`) và lược bỏ ảnh thừa trong `toolResult` khi truyền lên UI.
  - Chỉnh lại budget của `Researcher` subagent (`src/agent/subagents/researcher.ts`) tránh bị chạm `maxTurns` giữa chừng mà chưa trả về bản tóm tắt cuối.
- **GitHub Actions Build Workflows:**
  - `.github/workflows/custom-windows.yml`: Build trình cài đặt Windows x64 (`ChronoHarness-0.6.1-x64-setup.exe`), có thêm tùy chọn input `copilot_student` để áp dụng thử nghiệm [PR #223](https://github.com/amosblomqvist/learnharness/pull/223) cho GitHub Copilot Student khi chạy workflow.
  - `.github/workflows/terra-minimal-windows.yml`: Workflow riêng để kiểm thử và đóng gói bản backport tối giản chỉ thêm fallback `gpt-6.1-terra` trên nền v0.6.1 gốc.

---

## Hướng dẫn sử dụng nhanh

| Tác vụ | Thao tác trên ChronoHarness |
|---|---|
| **Cài model / API key** | Mở **Settings (`Ctrl+,`) → `Providers`** nhập API key (hoặc kết nối ChatGPT / GitHub Copilot / Grok / Claude Code), rồi chọn **`Strong`**, **`Cheap`**, **`Vision`** trong tab **`Agent`**. |
| **Thêm model mới / Ẩn provider** | Mở menu chọn model dưới ô chat → **`+ Add model ID`** để thêm tay; hoặc nhấn **`Pause <provider>`** để ẩn tạm. |
| **Ôn thi theo từng môn** | Ở thẻ **`ChronoHarness`** bên Sidebar: chuyển sang **`Exam Prep`** → **`+ New`** → bấm **`Choose subject`** tích chọn môn học → điền tên kỳ thi & ngày thi → **`Save`**. Bấm **`▴`/`▾`** để thu gọn thẻ xuống 1 dòng. |
| **Luyện ngay kiến thức yếu** | Bấm **`Drill`** trên thẻ Sidebar, hoặc vào **Graph → bật `FSRS` → `Practice weak`**. |
| **Nạp thẻ để FSRS nhận diện Graph** | Vào tab **`FLASHCARDS`** ở Sidebar → chọn cụm/mệnh đề từ Graph để sinh cue (hoặc dùng **`+ Create card`**). Sau đó ôn thẻ hoặc làm **Practice** (`conclude`) để FSRS tự cập nhật lịch. |
| **Ghi chú, trích dẫn & Copy LaTeX** | Bấm **`Notes`** ở góc trên phải chat; bôi đen chữ → **`Note`** để trích dẫn; click vào công thức toán để copy LaTeX; bấm **`Edit Last`** nếu muốn sửa lại câu vừa hỏi. |
| **Nhập sách `.epub` / tài liệu** | Ở màn hình **Graph** (hoặc Home), bấm **`Extract files…`** → chọn `.epub`, `.pdf`, `.md`, `.tex`, `.txt` (≤ 25 MB/file). |
| **Học & gửi ảnh từ điện thoại** | Bấm icon **QR / Điện thoại** cạnh ô nhập → chọn **`Any network (HTTPS)`** hoặc **`Same Wi-Fi (LAN)`** → quét QR → bấm **`Done`** để ẩn bảng QR nhưng giữ kết nối chạy nền. Dùng tab **`Photo`**, **`FSRS Cards`**, **`Exam & Chat`** (có **`📷 Camera`** & **`📎 Attach File`**). Khi cần ngắt hẳn, mở lại bảng QR bấm **`Disconnect`**. |
| **Xem lại & phân tích lỗi sai** | Bấm **`Mistakes`** dưới chân Sidebar trái (cạnh `Settings`) → chọn **`Scan past sessions`** (`Analyze them`) để quét lịch sử cũ hoặc mở nút **`Why`** ngay dưới câu vừa làm sai trong chat. |
| **Sao lưu / Chuyển máy** | **Settings (`Ctrl+,`) → `General` → `Backup & Restore` → `Export snapshot`**; sang máy mới bấm **`Restore snapshot`** và nhập lại API key ở **`Providers`**. |

---

## Nền tảng LearnHarness gốc

ChronoHarness kế thừa toàn bộ kiến trúc agent 4 pha từ [**LearnHarness**](https://github.com/amosblomqvist/learnharness):

1. **Measure (`Prober`):** Trước khi giảng, agent dò hiểu biết hiện có của bạn (dựa trên Graph + câu hỏi dò) để tìm đúng ranh giới bạn bắt đầu hổng hoặc nhầm.
2. **Plan:** Lập bản đồ phụ thuộc từ điểm xuất phát tới mục tiêu bài học và tự điều chỉnh khi câu trả lời của bạn rẽ hướng.
3. **Teach (`Teacher`):** Dạy từng bước có động cơ rõ ràng (`predict` → giải thích → `quiz` / `explain`), vá ngay chỗ hổng trước khi xây tầng tiếp theo.
4. **Practice (`Practice`):** Luyện truy hồi chủ động từ trạng thái không gợi tên định lý (`Recall` → `Discrimination` → `Composition`) với thang gợi ý tối thiểu `R0 → R5`.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

### Quyền riêng tư & dữ liệu cục bộ
- **Dùng key / gói đăng ký của bạn:** Không thu phí trung gian hay markup; đồng hồ chi phí ước tính theo bảng giá API đã biết (không tính cho gói subscription / CLI / custom endpoint).
- **Lưu trữ cục bộ trên máy:** Lịch sử chat, Knowledge Graph, Flashcards, ghi chú và cấu hình nằm hoàn toàn trên máy bạn dưới dạng file rõ ràng, dễ kiểm tra và sao lưu.
- **Mã nguồn mở có thể kiểm tra:** System prompt đều có thể xem và bật/tắt override trong phần cài đặt.

---

## Nền tảng hỗ trợ & Yêu cầu hệ thống

- **Windows x64 (bộ cài sẵn):** Hỗ trợ đầy đủ qua bộ cài [`ChronoHarness-0.6.1-x64-setup.exe`](https://github.com/2412khoidz/learnharness_khoifork/releases/latest) (cài & lưu dữ liệu song song, độc lập với LearnHarness gốc).
- **macOS (App Desktop Electron):** Cấu hình `electron-builder.yml` dùng **Electron `44.9.3`** (yêu cầu tối thiểu **`macOS 13 Ventura`** trở lên) với target đóng gói mặc định **`arm64` (Apple Silicon M1+)** *(hiện chưa phát hành sẵn file `.dmg` trên GitHub Releases)*.
- **Mac Intel đời cũ (`macOS 11 Big Sur` / `12 Monterey`) hoặc mở từ máy khác:**
  - **Cách nhẹ nhất (Web qua LAN / Tailscale):** Chạy bản Web server trên một máy Windows/Linux/Mac khác (`npm run build && npm run start -- -H 0.0.0.0 -p 3001`, có thể đặt `LH_DATA_DIR` và `LH_AUTH_FILE` tách riêng từng người theo [`docs/development.md`](docs/development.md#other-devices-on-your-network)), rồi truy cập từ **Firefox** hoặc **Chrome** trên máy Mac.
  - **Chạy Web độc lập trên Mac:** Lõi Next.js (`16.4.3`) cần `node >= 20.9.0` (`puppeteer-core >= 22.12.0`); có thể chạy web UI qua **Node.js 22 LTS+** (hỗ trợ macOS 11/12 Intel `x64`), lưu ý CI chính thức kiểm thử trên **Node.js 26**.

---

## Phát triển từ mã nguồn

Yêu cầu Node.js 26+ (khuyến nghị theo CI/release):

```bash
npm ci
npm run plugins:setup
npm run dev          # Chạy web UI tại http://localhost:3000
npm test             # Chạy bộ test với fixtures & fake providers
npm run typecheck    # Kiểm tra TypeScript
npm run lint         # Kiểm tra ESLint
```

Đóng gói server & kiểm tra Desktop Electron:

```bash
npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --electron
```

Tài liệu kỹ thuật gốc từ LearnHarness nằm trong [`docs/README.md`](docs/README.md) (bao gồm [Getting started](docs/getting-started.md), [Architecture](docs/architecture.md), [Development](docs/development.md), [Themes](docs/themes.md), [Plugin Authoring](docs/plugin-authoring.md), [Keyboard shortcuts](docs/keyboard.md), [Context, caching, and costs](docs/compaction-accounting.md)).

---

## Giấy phép

Phát hành theo giấy phép [**AGPL-3.0**](LICENSE), kế thừa từ [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).
