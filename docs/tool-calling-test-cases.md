# Bộ tình huống kiểm thử gọi công cụ

Trạng thái: đã có bộ chạy 4b và kiểm thử giả lập, dùng nguyên văn 10 câu bên dưới. Kết quả gọi mô hình thật được ghi riêng trong `tool-calling-compat.md`. Không dùng dữ liệu người dùng.

## Cách chạy và chấm

- **[Thay đổi v3] C1/C2 là kiểm thử HÀNH VI ĐÚNG, không chỉ lược đồ yêu cầu công cụ.** Mô hình trả lời thẳng ở C1/C2 (không gọi công cụ hoặc tự bịa `savingsForGoal=0`/thời hạn) bị đánh trượt cả “chọn đúng công cụ” và “đúng nghiệp vụ”. Với công cụ tiết kiệm không tham số, truyền `savingsForGoal` là khóa lạ và cũng sai lược đồ; nếu bịa số trong văn bản thì sai hành vi dù chưa phát sinh yêu cầu công cụ sai. Đây là phát hiện đúng hành vi sai, không phải lỗi bộ kiểm thử. Tỷ lệ >=95% hợp lệ là điều kiện cần, không đủ để bỏ qua các lỗi này.
- **[Cập nhật 4b] Quyền chạy:** Minh đã duyệt riêng mức 1 cho `deepseek-web/deepseek-v4-flash`, tối đa 10 lượt, dừng ngay khi lỗi giao thức. Mức 2/3 vẫn cần duyệt riêng. Không tự chạy đầy đủ chỉ vì tài liệu có năm lần lặp.
- Chạy cả 10 câu trên ít nhất 3 mô hình thuộc 3 nhà cung cấp thực thi khác nhau qua 9router. Ghi cả tên mô hình và nhà cung cấp thực tế; tên dòng mô hình không chứng minh nhà cung cấp thực thi.
- Đề xuất lặp 5 lần mỗi câu/mô hình: 50 lượt/mô hình, tối thiểu 150 lượt. Mỗi lần đặt lại dữ liệu giả và trạng thái. Không tự chuyển mô hình giữa một lần đo; lần lỗi vẫn nằm trong mẫu đo.
- Chế độ kiểm tra giao thức: đưa câu hỏi trực tiếp vào vòng lặp để kiểm tra công cụ, không để đường trả lời cục bộ bỏ qua mô hình. Đề xuất cập nhật dữ kiện từ lời hiện tại được nạp và kiểm chứng trước khi chạy; đo trích xuất dữ kiện bằng bộ kiểm thử riêng.
- Chế độ kiểm tra sản phẩm: chạy cùng câu qua đường cũ và bộ định tuyến nhỏ có cờ bật/tắt. Trả lời cục bộ đúng dữ liệu được chấm đạt nghiệp vụ; không chấm trượt chỉ vì không gọi mô hình. Kết quả này tách khỏi tỷ lệ công cụ hợp lệ.
- Giới hạn mỗi lượt: 3 vòng chọn công cụ + 1 lần chốt; 30 giây toàn lượt, 15 giây/lời gọi mô hình, 1.500 ms/công cụ. Mọi lần chờ, thử lại, đọc luồng và ghi kết quả đều nằm trong hạn toàn lượt.
- Giai đoạn đầu đặt `parallel_tool_calls: false`; câu cần 2 công cụ được gọi ở hai vòng hoặc được thực thi tuần tự nếu nhà cung cấp vẫn trả nhiều yêu cầu. Không bắt buộc thứ tự cho hai công cụ độc lập.
- Mỗi công cụ tối đa một lần cho cùng tham số và phiên bản trạng thái. Không dùng số tiền hoặc thời hạn mô hình tự tạo.
- Tham số tùy chọn bị bỏ qua được ứng dụng điền: `kind=null`, `category_id=null`, `limit=20`, `budget_id=null`. Bỏ qua và gửi null tương đương cho các trường cho phép null. Không sửa kiểu sai, không tự điền trường bắt buộc, không bỏ tham số lạ để làm yêu cầu sai thành hợp lệ.
- **[Thay đổi v3]** `plan_savings_goal` nhận giá trị tham số `{}`, với lược đồ `{"type":"object","properties":{},"additionalProperties":false}` đã đổi ngay vì tương thích; số tiền nằm trong trạng thái đã xác minh. Cục bộ vẫn từ chối khóa lạ. `kind` dùng `anyOf` cho chuỗi enum `income|expense` hoặc null, giữ mặc định null; không chứa null trong enum.
- Các câu tư vấn đi vào tác tử phải có ít nhất một công cụ trả `status: ok` trước khi chốt bằng mô hình. `needs_clarification` kết thúc bằng câu hỏi cục bộ, không được tính là phép tính thành công. Trả lời thẳng mà không gọi công cụ là lỗi chọn công cụ.
- Lần chốt dùng `allowTools=false`, `stream=true`, truyền SSE (sự kiện máy chủ gửi). Luồng bị đứt phải giữ phần đã hiển thị, lưu `incomplete=true`; không coi thiếu sự kiện `done` là hoàn tất.
- Quyết định Minh đã chốt: kiểm tra số và phạm vi theo câu/đoạn trước khi phát về giao diện; `delta.verification=segment_passed`, kiểm tra toàn văn trước `done`. Phần chưa đủ câu/đoạn hoặc đang chứa nửa số tiền chưa được phát.
- **[Thay đổi v3; làm rõ sau giai đoạn 1]** `classifyLocally` quyết định `allowedTools`. Tập cho phép lần lượt: S1={tổng quan}, S2={ngân sách}, S3={tiết kiệm}, S4={giao dịch}, S5={tiết kiệm}, D1={tổng quan,ngân sách}, D2={ngân sách,giao dịch}, D3={tiết kiệm,tổng quan}, C1/C2={tiết kiệm}. Tên công cụ tương ứng là bốn tên đầy đủ trong kỳ vọng từng câu. Một tên ngoài tập làm cả nhóm bị từ chối trước mọi thực thi, trả `tool_not_allowed` cho tất cả `tool_call_id`; hai nhóm bị từ chối liên tiếp thì dự phòng. Lời gọi chọn lại cùng bước logic vẫn tiêu ngân sách ba lần chọn và 30 giây.
- **[Thay đổi v3]** Với giai đoạn 3.5, `useAgentLoop=false` gọi thẳng đường cũ; `true` chỉ thêm định tuyến rồi trả cục bộ hoặc gọi đường cũ, chưa gọi điểm cuối mới. Dùng đầu ra giả lập ổn định để so 10 câu ở hai chế độ: cùng kết quả nghiệp vụ; đo phần tăng thêm cục bộ <50 ms, tách nhiễu mạng/mô hình. Tương đương nhau chưa chứng minh cả hai đều đúng nghiệp vụ cuối.

## Dữ liệu giả dùng chung

- Ngày tham chiếu: `2026-11-16`, múi giờ `Asia/Ho_Chi_Minh`; loại tiền VND, đơn vị đồng, số nguyên.
- Khoảng sáu tháng hoàn chỉnh: `2026-05-01` đến `2026-10-31`. Mỗi tháng thu 15.000.000, chi 10.000.000; chỉ số trung bình tương ứng 15.000.000 và 10.000.000; `months_with_data=6`.
- `liquid_balance=12.000.000` là kết quả tổng hợp giả của lớp dữ liệu. Đây KHÔNG phải tiền dành riêng cho mục tiêu. Dữ liệu giả phải được dựng phù hợp công thức tổng hợp hiện có, không sửa công thức để khớp số mẫu.
- Danh mục được phép gửi trong bối cảnh tối giản: `cat-food` = Ăn uống. Ngân sách `budget-food` = Ăn uống, tháng `2026-11`, hoạt động theo tháng, hạn mức 3.000.000, đã chi 3.500.000. Tiền còn trong hạn mức 0, vượt 500.000.
- Giao dịch ăn uống: `t-food-1` ngày 2026-11-02, 1.000.000; `t-food-2` ngày 2026-11-08, 2.000.000; `t-food-3` ngày 2026-11-15, 500.000. Không có giao dịch ăn uống khác trong khoảng kiểm thử. Không cần gửi ghi chú giao dịch.
- Tình huống tiết kiệm chuẩn `scenario-save`: thu nhập 15.000.000/tháng, tổng chi 10.000.000/tháng (đã gồm các khoản trả nợ), mục tiêu tổng 24.000.000, tiền dành riêng 0, thời hạn 6 tháng, cơ sở tính tháng. Tất cả có nguồn là lời người dùng đã xác minh; không cần khoảng ngày quan sát.
- Kết quả tiết kiệm chuẩn: dư trước mục tiêu 5.000.000/tháng; cần dành 4.000.000/tháng; còn 1.000.000/tháng sau phân bổ. Công cụ tính các số này, mô hình chỉ diễn giải.
- Mỗi câu là một lần chạy độc lập; chỉ S5 có dữ kiện cũ và lời đính chính được mô tả riêng. Không kế thừa dữ kiện từ câu kiểm thử trước.

## Nhóm A — Đơn giản: 5 câu

### S1 — Tổng quan sáu tháng

**Câu hỏi:** “Cho tôi xem thu nhập và chi tiêu trung bình mỗi tháng trong 6 tháng hoàn chỉnh gần nhất.”

- Công cụ bắt buộc: `get_financial_snapshot`.
- Tham số: `{"months":6,"fields":["monthly_income_avg","monthly_expense_avg"]}`; thứ tự phần tử không quan trọng.
- Kết quả: `status=ok`, hai chỉ số 15.000.000 và 10.000.000 VND/tháng, kỳ quan sát 2026-05-01 đến 2026-10-31.
- Câu trả lời phải ghi đây là trung bình lịch sử, không phải thu chi riêng tháng 11. Không tự tính thêm tỷ lệ tiết kiệm.

### S2 — Ngân sách vượt hạn mức

**Câu hỏi:** “Ngân sách Ăn uống tháng 11/2026 đã dùng bao nhiêu, còn bao nhiêu và có vượt không?”

- Công cụ bắt buộc: `calculate_budget_status`.
- Tham số: `{"month":"2026-11","budget_id":"budget-food"}`. Mã được lấy từ danh mục tối giản đã cung cấp, không được bịa.
- Kết quả: hạn mức 3.000.000, đã chi 3.500.000, còn 0, vượt 500.000 VND.
- Không được chặn `spentAmount` thành 3.000.000. Công cụ tính phần vượt, mô hình không tự trừ.

### S3 — Tiền dành riêng bằng 0

**Câu hỏi:** “Thu nhập của tôi 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng, tiền dành riêng hiện là 0 đồng. Mỗi tháng cần để dành bao nhiêu và còn bao nhiêu sau đó?”

- Trạng thái trước tính: tình huống chuẩn `scenario-save`, nguồn dữ kiện là câu hiện tại.
- Công cụ bắt buộc: `plan_savings_goal`.
- Tham số: `{}`.
- Kết quả: dư trước mục tiêu 5.000.000, cần dành 4.000.000, còn 1.000.000 VND/tháng; chưa đạt mục tiêu.
- Không hỏi lại tiền dành riêng, không lấy 12.000.000 số dư khả dụng thay số 0, không hỏi khoảng ngày giao dịch.

### S4 — Danh sách giao dịch có giới hạn

**Câu hỏi:** “Liệt kê 3 giao dịch chi Ăn uống gần nhất từ ngày 01/11/2026 đến hết ngày 16/11/2026.”

- Công cụ bắt buộc: `get_transactions`.
- Tham số: `{"from":"2026-11-01","to":"2026-11-16","kind":"expense","category_id":"cat-food","limit":3}`.
- Kết quả: thứ tự `t-food-3`, `t-food-2`, `t-food-1`, số tiền lần lượt 500.000, 2.000.000, 1.000.000 VND; `truncated=false` với dữ liệu giả này.
- Không gửi `raw_input`, `note_search` hoặc ghi chú. Không tự cộng danh sách thành tổng kỳ.

### S5 — Đính chính trong cùng tình huống

**Câu hỏi:** “Thực ra thu nhập của tôi là 12 triệu/tháng, các khoản khác và mục tiêu giữ nguyên. Tính lại giúp tôi.”

- Trước lượt: tình huống chuẩn `scenario-save`, dữ kiện thu nhập cũ `fact-income-15m`; trả lời trước là câu khẳng định không có dấu `?`.
- Cập nhật mong đợi: bubble (bong bóng tin nhắn) mới; dữ kiện mới 12.000.000 có `supersedes_id=fact-income-15m`; giữ `scenario-save`, tăng phiên bản trạng thái. Chỉ một lần xử lý lời người dùng, không chạy riêng một lượt đính chính rồi một lượt hỏi mới.
- Công cụ bắt buộc: `plan_savings_goal`; tham số `{}`.
- Kết quả: dư trước mục tiêu 2.000.000, cần dành 4.000.000, còn -2.000.000 VND/tháng sau phân bổ; giải thích kế hoạch hiện vượt khả năng dư hàng tháng.
- Không cộng thu nhập thành 27.000.000; không lấy thu nhập 15.000.000 từ tổng quan để ghi đè lời đính chính.

## Nhóm B — Cần 2 công cụ: 3 câu

### D1 — Tổng quan và ngân sách

**Câu hỏi:** “Cho tôi xem thu nhập, chi tiêu trung bình trong 6 tháng hoàn chỉnh gần nhất, đồng thời kiểm tra ngân sách Ăn uống tháng 11/2026. Trình bày riêng hai phần.”

- Công cụ 1: `get_financial_snapshot`, `{"months":6,"fields":["monthly_income_avg","monthly_expense_avg"]}`.
- Công cụ 2: `calculate_budget_status`, `{"month":"2026-11","budget_id":"budget-food"}`.
- Kết quả: trung bình 15.000.000 và 10.000.000 VND/tháng; ngân sách hạn 3.000.000, chi 3.500.000, vượt 500.000 VND.
- Cả hai công cụ phải thành công trước lần chốt. Không lấy trung bình lịch sử làm số chi ngân sách tháng 11; không tự cộng các đại lượng khác kỳ.

### D2 — Ngân sách và các giao dịch phía sau

**Câu hỏi:** “Kiểm tra ngân sách Ăn uống tháng 11/2026 và cho tôi xem 3 khoản chi ăn uống gần nhất từ 01/11/2026 đến 16/11/2026 để biết các khoản nào liên quan.”

- Công cụ 1: `calculate_budget_status`, `{"month":"2026-11","budget_id":"budget-food"}`.
- Công cụ 2: `get_transactions`, `{"from":"2026-11-01","to":"2026-11-16","kind":"expense","category_id":"cat-food","limit":3}`.
- Kết quả: ngân sách vượt 500.000; danh sách ba giao dịch và thứ tự như S4.
- Tổng ngân sách lấy từ công cụ ngân sách, không suy ra bằng cộng danh sách giao dịch. Không khẳng định một giao dịch là nguyên nhân duy nhất làm vượt.

### D3 — Tách số dư ví và tiền dành riêng

**Câu hỏi:** “Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ, mục tiêu 24 triệu trong 6 tháng và tôi chưa dành riêng đồng nào. Tính mức tiết kiệm cần thiết; đồng thời cho biết riêng số dư khả dụng hiện có trong ứng dụng.”

- Trạng thái: tình huống chuẩn, `savingsForGoal=0` được xác minh từ câu hiện tại.
- Công cụ 1: `plan_savings_goal`, `{}`.
- Công cụ 2: `get_financial_snapshot`, `{"months":6,"fields":["liquid_balance"]}`. Trong phép đo giao thức, cửa sổ mặc định trong ngữ cảnh là 6 tháng; số dư là tại ngày tham chiếu, không phải trung bình sáu tháng. Những cửa sổ hợp lệ khác không làm thay đổi chỉ số số dư được chấp nhận về nghiệp vụ và ghi riêng khác biệt tham số.
- Kết quả: cần dành 4.000.000/tháng; còn 1.000.000/tháng sau phân bổ; số dư khả dụng riêng 12.000.000 VND tại 2026-11-16.
- Không dùng số dư ví thay tiền đã dành riêng để hạ mức cần dành xuống 2.000.000/tháng. Không sửa slot (trường trạng thái) tiền dành riêng sau khi đọc tổng quan.

## Nhóm C — Cần làm rõ: 2 câu

### C1 — Thiếu tiền đã dành riêng

**Câu hỏi:** “Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn đủ 24 triệu trong 6 tháng; mỗi tháng phải dành bao nhiêu?”

- Trạng thái: thu, chi, mục tiêu, thời hạn và cơ sở tháng đã biết; `savingsForGoal` chưa biết. Không kế thừa số 0 từ S3.
- Công cụ bắt buộc: `plan_savings_goal`, `{}`.
- Kết quả: `{"status":"needs_clarification","fields":["savingsForGoal"]}`.
- Câu hỏi mong đợi: “Bạn đã dành riêng bao nhiêu tiền cho mục tiêu này? Nếu chưa có, bạn có thể trả lời 0 đồng.”
- Chấp nhận cách diễn đạt tương đương cùng ý nghĩa. Không mặc định bằng 0 hoặc số dư ví; không chốt số tiền phải dành; không chạy lần chốt AI không cần thiết.

### C2 — Thiếu thời hạn mục tiêu

**Câu hỏi:** “Thu nhập 15 triệu/tháng, tổng chi 10 triệu/tháng đã gồm trả nợ. Tôi muốn tiết kiệm đủ 24 triệu, hiện tiền dành riêng là 0 đồng. Mỗi tháng cần dành bao nhiêu?”

- Trạng thái: chỉ thiếu `savingsMonths`, không có thời hạn mặc định.
- Công cụ bắt buộc: `plan_savings_goal`, `{}`.
- Kết quả: `{"status":"needs_clarification","fields":["savingsMonths"]}`.
- Câu hỏi mong đợi: “Bạn muốn đạt mục tiêu này trong bao nhiêu tháng?”
- Không hỏi khoảng ngày đọc giao dịch; không tự chọn 6 tháng từ khoảng tổng quan; không tự mặc định 12 tháng.

## Chỉ số và điều kiện chọn mô hình

Ghi kết quả vào `docs/tool-calling-compat.md`; hiện chưa đo nên không điền số ước lượng.

| Chỉ số | Định nghĩa |
|---|---|
| Công cụ hợp lệ | Số yêu cầu đúng tên, JSON và lược đồ sau khi CHỈ điền mặc định đã công bố / toàn bộ yêu cầu công cụ phát sinh. Báo cả số trước chuẩn hóa; `plan_savings_goal` có khóa lạ bị loại. |
| Hoàn thành yêu cầu công cụ | Số lượt đã gọi đủ tập công cụ bắt buộc / tổng lượt. Không có yêu cầu công cụ không được coi là 100% hợp lệ. |
| Chọn đúng công cụ | Số lượt gọi đúng tập công cụ cần thiết và không gọi thừa / tổng lượt. Không đòi thứ tự giữa hai công cụ độc lập. |
| Đúng nghiệp vụ | Số lượt khớp số, đơn vị, kỳ, tình huống và yêu cầu làm rõ / tổng lượt. |
| Độ trễ | Trung bình từ bắt đầu đến `done`, câu hỏi cục bộ hoặc kết thúc lỗi; báo riêng thời gian đến phần hiển thị đầu tiên và các lượt hết 30 giây. Không bỏ lượt thất bại khỏi thống kê. |
| Dự phòng | Số lượt phải dùng câu trả lời dự phòng / tổng lượt. Hai câu làm rõ đúng kỳ vọng không tính là dự phòng. |
| Chi phí văn bản mô hình | Tổng đơn vị đầu vào/đầu ra của TẤT CẢ lời gọi và thử lại trong lượt, kèm trung bình/lượt. Thiếu `usage` thì ghi “không có”, không ghi 0. Đây chưa phải chi phí tiền khi chưa có đơn giá. |

- Điều kiện bắt buộc để xét vào danh sách cho phép: ít nhất 95% yêu cầu công cụ hợp lệ. Với 5 lần lặp và hành vi chuẩn, có 65 yêu cầu công cụ/mô hình; phải ghi mẫu số thực tế, không cố định 65 nếu mô hình gọi sai/thừa/thiếu.
- 95% hợp lệ chỉ là điều kiện cần. Không đưa mô hình vào sử dụng nếu nó trả lời không có công cụ, bịa số, ghi đè tình huống, thiếu một công cụ bắt buộc hoặc không bảo toàn dữ liệu khi luồng đứt.
- Tỷ lệ một lần chạy trên 10 câu chỉ có giá trị thăm dò; không suy ra độ tin cậy dài hạn hoặc tương thích mọi nhà cung cấp.
- So sánh bộ định tuyến nhỏ với luồng cũ: cùng dữ liệu và tiêu chí nghiệp vụ. Mỗi câu đã đạt ở đường cũ phải tiếp tục đạt ở đường mới; tổng số câu đạt không thấp hơn. Ghi độ trễ, đơn vị văn bản và dự phòng riêng, không che đánh đổi bằng một điểm tổng hợp.

## Kiểm tra giao thức bổ sung ngoài 10 câu

Đây là biến thể lỗi, không tăng bộ câu hỏi nghiệp vụ lên quá 10:

- Bỏ các trường tùy chọn: điền đúng mặc định; gửi null cho trường nullable (cho phép rỗng): được chấp nhận. Bỏ `from`, `to`, `month`, `months` hoặc `fields` bắt buộc: từ chối.
- JSON lỗi, khóa lạ, ngày không tồn tại, khoảng đảo ngược, tiền vượt giới hạn, số tiền do mô hình tự thêm: không thực thi.
- Mô hình trả văn bản hoặc từ chối ở vòng đầu mà chưa có công cụ thành công: câu trả lời dự phòng xác định, không hiển thị như tư vấn đã kiểm chứng.
- Nhóm có công cụ ngoài `allowedTools`: không chạy BẤT KỲ công cụ nào, không tăng số thành công, trả lỗi cho mọi `tool_call_id`; lần đầu được chọn lại trong ngân sách, nhóm bị từ chối thứ hai liên tiếp thì dừng. Chỉ nhóm có tất cả tên hợp lệ mới đặt lại bộ đếm. Không dùng cơ chế lỗi thực thi lặp để dừng ngay lần đầu.
- Hai thứ tự `[hợp lệ, ngoài danh sách]` và `[ngoài danh sách, hợp lệ]` đều có số lần thực thi bằng 0, đủ một lỗi cho mỗi mã lời gọi. Hai tên ngoài danh sách trong cùng nhóm chỉ tăng bộ đếm nhóm một lần. Kết quả công cụ từ nhóm trước không bị xóa hoặc đếm lại; không có kết quả một phần từ nhóm bị từ chối. Thử chọn lại vẫn chịu trần ba lần chọn và 30 giây.
- Lặp cùng công cụ hoặc cùng lỗi: không đọc/tính lặp vô hạn; công cụ thất bại không tăng bộ đếm thành công.
- Luồng SSE chia giữa ký tự UTF-8, dòng sự kiện và chuỗi số tiền; thiếu `[DONE]`, `finish_reason=length`, bị ngắt sau phần đã hiển thị: không đánh dấu hoàn tất, giữ nội dung và `incomplete=true`.
- Lần chốt bất ngờ chứa yêu cầu công cụ dù `tool_choice=none`: không thực thi.
- Một lượt có nhiều vòng hoặc thử lại chỉ trừ một lượt hạn mức; lời chào/xác nhận cục bộ không gọi mô hình. Giới hạn lời gọi hệ thống vẫn áp dụng độc lập.
- Hai lời gọi đã dùng hết 30 giây -> không gọi lần ba hoặc chốt; dùng dự phòng xác định. Chọn lại công cụ ngoài quyền vẫn phải tính vào tối đa ba lời gọi chọn.
- Chuyển/xóa phiên trong lúc chờ: không cập nhật phiên khác hoặc khôi phục phiên đã xóa; câu trả lời dở dang không được dùng như dữ kiện đã xác minh cho lượt sau.
