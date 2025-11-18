
link api: https://unmummifying-brayan-preactively.ngrok-free.dev

# Teambuilding Backend — API Overview

Hệ thống backend cho trò chơi **Teambuilding Realtime**, gồm 6 API chính và các sự kiện realtime qua **Socket.IO**.

---

## POST /api/answer
**Chức năng:** Đội chơi đoán từ khóa của hành tinh.

**Input**
```json
{
  "planet_id": "MARS01",
  "answer": "sunshine"
}


Status	Mô tả
success	Đoán đúng, trả về thứ hạng hành tinh trong chi nhánh
fail	Sai, trả số lượt còn lại
not done	Quiz chưa hoàn thành, chưa được đoán
expire	Hết lượt đoán (10 lượt)

Ví dụ

{
  "planet_id": "MARS01",
  "status": "success",
  "ranking": {
    "branch": "HN",
    "rank": 2,
    "time_used_str": "00:03:20"
  }
}
2️⃣ POST /api/match
Chức năng: Ghép cặp hành tinh với hành tinh mục tiêu.

{
  "main_planet": "MARS01",
  "target_planet": "VENUS02"
}

Status	Ý nghĩa
not done	Target chưa đoán xong (iscorrect != 1)
false	Ghép sai, tăng lượt
expire	Quá 10 lượt thử
success + complete: not done	Main ghép đúng, chờ target
success + complete: done	Cả hai ghép đúng, trả rank cặp

Ví dụ (hoàn thành)

{
  "main_planet": "MARS01",
  "status": "success",
  "complete": "done",
  "ranking": {
    "pairkey": "P001",
    "pair_rank": 2,
    "pair_total_time_str": "00:07:30",
    "planets": ["MARS01", "VENUS02"]
  }
}
🏆 3️⃣ GET /api/leaderboard
Chức năng: Lấy bảng xếp hạng đoán từ và ghép cặp.

Output


{
  "guessLeaderboard": {
    "HN": [
      { "rank": 1, "planet_id": "MARS01", "time_used_str": "00:03:20" }
    ]
  },
  "mapLeaderboard": [
    {
      "pairkey": "P001",
      "planets": ["MARS01", "VENUS02"],
      "rank": 1,
      "pair_total_time_str": "00:07:30"
    }
  ]
}

🧠 4️⃣ POST /api/quiz
Chức năng: Lấy quiz tiếp theo hoặc hint sau khi hoàn thành.

Input

json
Copy code
{
  "team": "Team A",
  "number": "1"
}
Output

Status	Ý nghĩa
in_progress	Còn quiz cần làm (trả quiz_index = quiz1/quiz2)
complete	Đã hoàn thành tất cả quiz, trả hint

Ví dụ

json
Copy code
{
  "team": "Team A",
  "number": "1",
  "status": "in_progress",
  "quiz_index": "quiz1",
  "nextQuiz": {
    "question": "What is the capital of France?"
  }
}
Hoặc nếu hoàn thành:

json
Copy code
{
  "team": "Team A",
  "number": "1",
  "status": "complete",
  "hint": "Use the first letters to find the word."
}
📝 5️⃣ POST /api/answer-quiz
Chức năng: Gửi đáp án cho quiz1 hoặc quiz2.

Input

json
Copy code
{
  "team": "Team A",
  "number": "1",
  "quiz_index": "quiz1",
  "answer": "Paris"
}
Output

Status	Mô tả
success	Đúng → cập nhật iscorrect + trả hint
false	Sai

Ví dụ

json
Copy code
{
  "team": "Team A",
  "number": "1",
  "quiz_index": "quiz1",
  "status": "success",
  "hint": "Use the first letters to find the word."
}


# Socket.IO Events 

Event	Khi nào	Payload ví dụ
team_update	Khi hành tinh đoán đúng hoặc ghép đúng (1 bên)	{ planet_id, status: "success", ranking }
map_complete	Khi cả hai hành tinh cùng ghép thành công	{ pairkey, planets, status: "complete", ranking }



# API: /api/available-planets
Mục đích

API này phục vụ cho game Teambuilding, giúp xác định:

Trạng thái hiện tại (stage) của một hành tinh (planet_id) trong tiến trình trò chơi.

Danh sách các hành tinh đã đoán đúng (iscorrect = 1) được chia thành:

Các hành tinh cùng chi nhánh (branch)

Các hành tinh khác chi nhánh (branch)

Với những stage phù hợp, API còn trả về thứ hạng (ranking) của hành tinh trong cuộc thi.

Phương thức

POST

Endpoint
/api/available-planets

Input
Trường  Kiểu dữ liệu  Bắt buộc  Mô tả
planet_id  string  ✅  ID của hành tinh cần kiểm tra
Ví dụ Request
{
  "planet_id": "P103"
}

Logic xử lý

1️⃣ Xác định thông tin hành tinh hiện tại

Lấy từ bảng "Game"."teambuilding" theo planet_id

Gồm: iscorrect, map, pairkey, branch, word, v.v.

2️⃣ Xác định stage hiện tại của planet

Stage  Điều kiện
"guess"  iscorrect IS NULL OR iscorrect = '0'
"map"  iscorrect = '1' AND (map IS NULL OR map = '0')
"waitpair"  iscorrect = '1' AND map = '1' AND team cùng pairkey có map ≠ '1'
"complete"  iscorrect = '1' AND map = '1' AND team cùng pairkey cũng map = '1'`

3️⃣ Truy vấn danh sách planet đã đoán đúng (iscorrect = '1')

Cùng branch: chỉ trả về planet_id

Khác branch: trả về planet_id + word (để team có thể thấy gợi ý từ các branch khác)

4️⃣ Tính ranking (nếu stage là map hoặc complete):

guess_rank:
Thứ hạng dựa trên thời gian đoán đúng (guess_timestamp ASC)

map_rank:
(Chỉ với stage complete) — thứ hạng của cặp (pairkey) dựa trên tổng thời gian hoàn thành map (map_timestamp)

Output
Trường      Kiểu     Mô tả
status      string   "success" hoặc "error"
planet_id   string   ID hành tinh yêu cầu
stage       string   Trạng thái hiện tại (guess, map, waitpair, complete)
ranking     object   Gồm guess_rank và map_rank (có thể null)
sameBranch  array    Danh sách planet_id cùng branch đã đoán đúng
otherBranch  array    Danh sách planet khác branch đã đoán đúng (planet_id + word)
Ví dụ Output
1️⃣ Stage: guess
{
  "status": "success",
  "planet_id": "P102",
  "stage": "guess",
  "ranking": {
    "guess_rank": null,
    "map_rank": null
  },
  "sameBranch": ["P101"],
  "otherBranch": [
    { "planet_id": "P201", "word": "SUN" },
    { "planet_id": "P301", "word": "EARTH" }
  ]
}

2️⃣ Stage: map
{
  "status": "success",
  "planet_id": "P105",
  "stage": "map",
  "ranking": {
    "guess_rank": 4,
    "map_rank": null
  },
  "sameBranch": ["P101", "P104"],
  "otherBranch": [
    { "planet_id": "P201", "word": "SUN" },
    { "planet_id": "P301", "word": "EARTH" }
  ]
}

3️⃣ Stage: complete
{
  "status": "success",
  "planet_id": "P203",
  "stage": "complete",
  "ranking": {
    "guess_rank": 2,
    "map_rank": 1
  },
  "sameBranch": ["P201", "P202"],
  "otherBranch": [
    { "planet_id": "P301", "word": "EARTH" }
  ]
}
 