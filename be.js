// ======================================
// 🌍 TEAMBUILDING BACKEND — FINAL BUILD
// ======================================
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { Pool } = require("pg");

// =============================
// ⚙️ CONFIG
// =============================
const APP_PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";
const PGSCHEMA = process.env.PGSCHEMA || "Game";
const TIME_START = new Date("2025-11-07T09:00:00+07:00");

// =============================
// 🗄️ POSTGRES
// =============================
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASS,
  database: process.env.PGDATABASE,
});

const TB_TABLE = `"${PGSCHEMA}"."teambuilding"`;
const QUIZ_TABLE = `"${PGSCHEMA}"."quiz_teambuilding"`;

// =============================
// 🚀 APP + SOCKET.IO
// =============================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// =============================
// 🧭 Helper functions
// =============================
function getVNTimeString() {
  const now = new Date();
  const vnTime = new Date(now.getTime() + 7 * 60 * 60 * 1000 - now.getTimezoneOffset() * 60000);
  return vnTime.toISOString().replace("T", " ").substring(0, 19);
}

function formatDuration(seconds) {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

// =============================
// 1️⃣ POST /api/answer
// =============================
app.post("/api/answer", async (req, res) => {
  const { planet_id, answer } = req.body || {};
  if (!planet_id || !answer)
    return res.status(400).json({ status: "fail", message: "Missing planet_id or answer" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lấy team tương ứng planet_id
    const teamQ = await client.query(
      `SELECT team, branch FROM ${TB_TABLE} WHERE planet_id = $1 FOR UPDATE`,
      [planet_id]
    );
    if (teamQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Planet not found" });
    }
    const { team, branch } = teamQ.rows[0];

    // Check quiz_teambuilding -> có iscorrect = 0 không?
    const quizQ = await client.query(
      `SELECT * FROM ${QUIZ_TABLE} WHERE team = $1`,
      [team]
    );

    const hasIncompleteQuiz = quizQ.rows.some(
      (r) => r.iscorrect1 === "0" || r.iscorrect2 === "0"
    );
    if (hasIncompleteQuiz) {
      await client.query("ROLLBACK");
      return res.json({ planet_id, status: "not done" });
    }

    // Lấy word + turn_number
    const tbQ = await client.query(
      `SELECT word, iscorrect, COALESCE(guess_turn_number, '0') AS guess_turn_number
       FROM ${TB_TABLE} WHERE planet_id = $1 FOR UPDATE`,
      [planet_id]
    );
    const row = tbQ.rows[0];
    const currentTurns = Number(row.guess_turn_number || 0);
    if (currentTurns >= 100) {
      await client.query("ROLLBACK");
      return res.json({ planet_id, status: "expire" });
    }

    const isCorrect =
      String(answer).trim().toLowerCase() === String(row.word || "").trim().toLowerCase();

    if (isCorrect) {
      const ts = getVNTimeString();
      await client.query(
        `UPDATE ${TB_TABLE}
         SET iscorrect = '1', guess_timestamp = $2
         WHERE planet_id = $1`,
        [planet_id, ts]
      );
      await client.query("COMMIT");

      // Tính ranking realtime
      const guessQ = await client.query(
        `SELECT planet_id, branch, guess_timestamp
         FROM ${TB_TABLE}
         WHERE iscorrect = '1' AND guess_timestamp IS NOT NULL AND branch = $1
         ORDER BY guess_timestamp ASC`,
        [branch]
      );
      const rank = guessQ.rows.findIndex((r) => r.planet_id === planet_id) + 1;
      const time_used = Math.floor((new Date(ts) - TIME_START) / 1000);

      const ranking = {
        branch,
        rank,
        time_used,
        time_used_str: formatDuration(time_used),
      };

      io.emit("team_update", { planet_id, status: "success", ranking });
      return res.json({ planet_id, status: "success", ranking });
    } else {
      const newTurns = currentTurns + 1;
      await client.query(
        `UPDATE ${TB_TABLE} SET guess_turn_number = $2 WHERE planet_id = $1`,
        [planet_id, String(newTurns)]
      );
      await client.query("COMMIT");
      return res.json({
        planet_id,
        status: "fail",
        turn_remaining: Math.max(0, 100 - newTurns),
      });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/answer error:", err);
    return res.status(500).json({ status: "error" });
  } finally {
    client.release();
  }
});

// =============================
// 2️⃣ POST /api/match
// =============================
app.post("/api/match", async (req, res) => {
  const { main_planet, target_planet } = req.body || {};
  if (!main_planet || !target_planet)
    return res.status(400).json({ status: "fail", message: "Missing main_planet or target_planet" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const targetQ = await client.query(
      `SELECT planet_id, pairkey, map, iscorrect, map_timestamp FROM ${TB_TABLE} WHERE planet_id = $1 FOR UPDATE`,
      [target_planet]
    );
    if (targetQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Target planet not found" });
    }

    const target = targetQ.rows[0];
    if (target.iscorrect !== "1") {
      await client.query("ROLLBACK");
      return res.json({ main_planet, status: "not done" });
    }

    const mainQ = await client.query(
      `SELECT planet_id, pairkey, map, map_turn_number FROM ${TB_TABLE} WHERE planet_id = $1 FOR UPDATE`,
      [main_planet]
    );
    if (mainQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Main planet not found" });
    }

    const main = mainQ.rows[0];
    const currentTurns = Number(main.map_turn_number || 0);
    if (currentTurns >= 100) {
      await client.query("ROLLBACK");
      return res.json({ main_planet, status: "expire" });
    }

    if (main.pairkey !== target.pairkey) {
      const newTurns = currentTurns + 1;
      await client.query(
        `UPDATE ${TB_TABLE} SET map_turn_number = $2 WHERE planet_id = $1`,
        [main_planet, String(newTurns)]
      );
      await client.query("COMMIT");
      return res.json({
        main_planet,
        status: "false",
        turn_remaining: Math.max(0, 100 - newTurns),
      });
    }

    // ✅ Pairkey giống nhau
    const ts = getVNTimeString();
    await client.query(
      `UPDATE ${TB_TABLE}
       SET map = '1', map_timestamp = $2
       WHERE planet_id = $1`,
      [main_planet, ts]
    );

    // ✨ Gửi sự kiện realtime cho client biết hành tinh này đã được map
    io.emit("planet_mapped", { planet_id: main_planet });

    // Kiểm tra xem target đã map chưa
    const targetMapped = target.map === "1";
    await client.query("COMMIT");

    if (!targetMapped) {
      io.emit("team_update", { main_planet, status: "success", complete: "not done" });
      return res.json({ main_planet, status: "success", complete: "not done" });
    }

    // 🎯 Cả hai planet đều map xong
    const pairQ = await client.query(
      `SELECT planet_id, map_timestamp
       FROM ${TB_TABLE}
       WHERE pairkey = $1 AND map = '1' AND map_timestamp IS NOT NULL`,
      [main.pairkey]
    );
    if (pairQ.rowCount < 2) {
      return res.json({ main_planet, status: "success", complete: "not done" });
    }

    const [p1, p2] = pairQ.rows;
    const totalTime =
      Math.floor((new Date(p1.map_timestamp) - TIME_START) / 1000) +
      Math.floor((new Date(p2.map_timestamp) - TIME_START) / 1000);

    // Tính rank của cặp
    const allPairs = await client.query(`
      SELECT pairkey,
             SUM(EXTRACT(EPOCH FROM (map_timestamp - TIMESTAMP '${TIME_START.toISOString()}'))) AS total_time
      FROM ${TB_TABLE}
      WHERE map = '1' AND map_timestamp IS NOT NULL
      GROUP BY pairkey
      HAVING COUNT(*) >= 2
      ORDER BY total_time ASC
    `);
    const pairRank = allPairs.rows.findIndex((r) => r.pairkey === main.pairkey) + 1;

    const ranking = {
      pairkey: main.pairkey,
      pair_rank: pairRank,
      pair_total_time: totalTime,
      pair_total_time_str: formatDuration(totalTime),
      planets: [p1.planet_id, p2.planet_id],
    };

    io.emit("map_complete", {
      pairkey: main.pairkey,
      planets: [p1.planet_id, p2.planet_id],
      status: "complete",
      ranking,
    });

    return res.json({
      main_planet,
      status: "success",
      complete: "done",
      ranking,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/match error:", err);
    return res.status(500).json({ status: "error" });
  } finally {
    client.release();
  }
});

// =============================
// 3️⃣ GET /api/leaderboard
// =============================
app.get("/api/leaderboard", async (_req, res) => {
  const client = await pool.connect();
  try {
    // 🧩 BXH đoán từ
    const guessQ = await client.query(`
      SELECT planet_id, branch, guess_timestamp
      FROM ${TB_TABLE}
      WHERE iscorrect = '1' AND guess_timestamp IS NOT NULL
      ORDER BY branch ASC, guess_timestamp ASC
    `);

    const guessGrouped = {};
    for (const r of guessQ.rows) {
      const ts = r.guess_timestamp ? new Date(r.guess_timestamp) : null;
      const time_used = ts ? Math.floor((ts - TIME_START) / 1000) : null;
      const time_used_str = formatDuration(time_used);
      if (!guessGrouped[r.branch]) guessGrouped[r.branch] = [];
      guessGrouped[r.branch].push({
        planet_id: r.planet_id,
        time_used,
        time_used_str,
      });
    }

    for (const branch in guessGrouped) {
      guessGrouped[branch].sort((a, b) => a.time_used - b.time_used);
      guessGrouped[branch] = guessGrouped[branch].map((x, i) => ({
        rank: i + 1,
        ...x,
      }));
    }

    // 🪐 BXH ghép cặp
    const mapQ = await client.query(`
      SELECT pairkey,
             array_agg(planet_id) AS planets,
             SUM(EXTRACT(EPOCH FROM (map_timestamp - TIMESTAMP '${TIME_START.toISOString()}'))) AS total_time
      FROM ${TB_TABLE}
      WHERE map = '1' AND map_timestamp IS NOT NULL
      GROUP BY pairkey
      HAVING COUNT(*) >= 2
      ORDER BY total_time ASC
    `);

    const mapLeaderboard = mapQ.rows.map((r, i) => ({
      pairkey: r.pairkey,
      planets: r.planets,
      rank: i + 1,
      pair_total_time: Math.floor(r.total_time),
      pair_total_time_str: formatDuration(Math.floor(r.total_time)),
    }));

    return res.json({
      guessLeaderboard: guessGrouped,
      mapLeaderboard,
    });
  } catch (err) {
    console.error("GET /api/leaderboard error:", err);
    return res.status(500).json({ status: "error" });
  } finally {
    client.release();
  }
});

// =============================
// 🧩 NEW API — /api/quiz (v2)
// =============================
// Mục đích: Lấy câu hỏi quiz kế tiếp hoặc hint nếu hoàn thành
app.post("/api/quiz", async (req, res) => {
  const { team, number } = req.body || {};
  if (!team || !number)
    return res.status(400).json({ status: "fail", message: "Missing team or number" });

  const client = await pool.connect();
  try {
    // 🔹 Lấy dòng quiz tương ứng
    const quizQ = await client.query(
      `SELECT quiz1, answer1, iscorrect1, quiz2, answer2, iscorrect2, hint
       FROM ${QUIZ_TABLE}
       WHERE team = $1 AND number = $2`,
      [team, number]
    );

    if (quizQ.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "Quiz not found for this team" });

    const quiz = quizQ.rows[0];
    const hasQuiz2 = quiz.quiz2 !== null && quiz.quiz2.trim() !== "";

    const q1done = quiz.iscorrect1 === "1";
    const q2done = hasQuiz2 ? quiz.iscorrect2 === "1" : true;

    // ✅ Nếu cả hai đều xong → gửi hint
    if (q1done && q2done) {
      return res.json({
        team,
        number,
        status: "complete",
        hint: quiz.hint,
      });
    }

    // 🔹 Xác định quiz kế tiếp
    let nextQuiz = null;
    let quiz_index = null;

    if (!q1done) {
      nextQuiz = quiz.quiz1;
      quiz_index = "quiz1";
    } else if (hasQuiz2 && !q2done) {
      nextQuiz = quiz.quiz2;
      quiz_index = "quiz2";
    }

    if (!nextQuiz)
      return res.json({ team, number, status: "done", hint: quiz.hint });

    return res.json({
      team,
      number,
      status: "in_progress",
      quiz_index, // 👈 trả thêm quiz_index = 'quiz1' hoặc 'quiz2'
      nextQuiz: {
        question: nextQuiz
      }
    });
  } catch (err) {
    console.error("POST /api/quiz error:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  } finally {
    client.release();
  }
});

// =============================
// 📝 POST /api/answer-quiz
// Input: { team, number, quiz_index, answer }
// quiz_index: "quiz1" hoặc "quiz2"
// =============================
app.post("/api/answer-quiz", async (req, res) => {
  const { team, number, quiz_index, answer } = req.body || {};

  if (!team || !number || !quiz_index || !answer) {
    return res.status(400).json({ status: "fail", message: "Missing team, number, quiz_index or answer" });
  }

  if (!["quiz1", "quiz2"].includes(quiz_index)) {
    return res.status(400).json({ status: "fail", message: "quiz_index must be 'quiz1' or 'quiz2'" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lấy bản ghi quiz cho team + number
    const q = await client.query(
      `SELECT quiz1, answer1, iscorrect1, quiz2, answer2, iscorrect2, hint
       FROM ${QUIZ_TABLE}
       WHERE team = $1 AND number = $2
       FOR UPDATE`,
      [team, number]
    );

    if (q.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ status: "fail", message: "Quiz not found for this team/number" });
    }

    const row = q.rows[0];

    // Kiểm tra tồn tại quiz2 nếu user gửi quiz2
    const hasQuiz2 = row.quiz2 !== null && String(row.quiz2).trim() !== "";
    if (quiz_index === "quiz2" && !hasQuiz2) {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: "quiz2 does not exist for this entry" });
    }

    // Lấy đáp án đúng đang lưu trong DB (mình giả sử answer1/answer2 là đáp án đúng)
    const expectedAnswer = quiz_index === "quiz1" ? row.answer1 : row.answer2;
    // Nếu expectedAnswer null => không có đáp án lưu sẵn => trả lỗi
    if (expectedAnswer == null) {
      await client.query("ROLLBACK");
      return res.status(400).json({ status: "fail", message: "Correct answer not configured for this quiz" });
    }

    const given = String(answer).trim().toLowerCase();
    const expected = String(expectedAnswer).trim().toLowerCase();

    // So sánh
    const matched = given === expected;

    if (matched) {
      // Cập nhật iscorrect
      if (quiz_index === "quiz1") {
        await client.query(
          `UPDATE ${QUIZ_TABLE} SET iscorrect1 = '1' WHERE team = $1 AND number = $2`,
          [team, number]
        );
      } else {
        await client.query(
          `UPDATE ${QUIZ_TABLE} SET iscorrect2 = '1' WHERE team = $1 AND number = $2`,
          [team, number]
        );
      }

      await client.query("COMMIT");

      // Trả ra hint (theo yêu cầu)
      return res.json({
        team,
        number,
        status: "success",
        quiz_index,
        hint: row.hint || null,
      });
    } else {
      await client.query("ROLLBACK");
      return res.json({ team, number, status: "false" });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/answer-quiz error:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  } finally {
    client.release();
  }
});

// =============================
// 🪐 NEW API — /api/available-planets
// =============================
// Input: { planet_id }
// Output:
// - Danh sách planet_id có iscorrect = 1 ở branch khác
// - Nếu không có -> status: none
app.post("/api/available-planets", async (req, res) => {
  const { planet_id } = req.body || {};
  if (!planet_id)
    return res.status(400).json({ status: "fail", message: "Missing planet_id" });

  const client = await pool.connect();
  try {
    // 1️⃣ Lấy thông tin planet hiện tại
    const planetQ = await client.query(
      `SELECT planet_id, team, word, branch, iscorrect, map, pairkey, guess_timestamp, map_timestamp
       FROM ${TB_TABLE}
       WHERE planet_id = $1`,
      [planet_id]
    );

    if (planetQ.rowCount === 0)
      return res.status(404).json({ status: "fail", message: "Planet not found" });

    const p = planetQ.rows[0];
    const { branch, iscorrect, map, pairkey } = p;

    // 2️⃣ Xác định stage
    let stage = "guess";
    if (iscorrect === "1") {
      if (!map || map === "0") {
        stage = "map";
      } else if (map === "1") {
        // Kiểm tra planet cùng pairkey
        const pairQ = await client.query(
          `SELECT planet_id, map FROM ${TB_TABLE} WHERE pairkey = $1 AND planet_id <> $2`,
          [pairkey, planet_id]
        );
        const pairPartner = pairQ.rows.find((r) => r.map === "1");
        stage = pairPartner ? "complete" : "waitpair";
      }
    }

    // 3️⃣ Lấy danh sách các planet đã đoán đúng
    const correctQ = await client.query(
      `SELECT planet_id, word, branch FROM ${TB_TABLE} WHERE iscorrect = '1'`
    );

    const sameBranch = [];
    const otherBranch = [];

    for (const row of correctQ.rows) {
      if (row.branch === branch) {
        sameBranch.push(row.planet_id);
      } else {
        otherBranch.push({
          planet_id: row.planet_id,
          word: row.word
        });
      }
    }

    // 4️⃣ Nếu stage = map hoặc complete → tính ranking
    let ranking = { guess_rank: null, map_rank: null };

    if (stage === "map" || stage === "complete") {
      // 🧩 Ranking đoán từ
      const guessQ = await client.query(
        `SELECT planet_id FROM ${TB_TABLE}
         WHERE iscorrect = '1' AND guess_timestamp IS NOT NULL
         ORDER BY guess_timestamp ASC`
      );

      const guessRank =
        guessQ.rows.findIndex((r) => r.planet_id === planet_id) + 1 || null;

      ranking.guess_rank = guessRank;

      // 🪐 Nếu stage = complete → tính thêm map rank
      if (stage === "complete" && pairkey) {
        const mapQ = await client.query(`
  SELECT pairkey, array_agg(map_timestamp) AS timestamps
  FROM ${TB_TABLE}
  WHERE map = '1' AND map_timestamp IS NOT NULL
  GROUP BY pairkey
  HAVING COUNT(*) >= 2
`);

const mapRankList = mapQ.rows.map(row => {
  const timestamps = row.timestamps
    .map(ts => new Date(ts)) // ép kiểu từ chuỗi sang Date
    .filter(ts => !isNaN(ts));

  // Tổng thời gian từng planet so với TIME_START
  const totalSeconds = timestamps.reduce((sum, ts) => {
    return sum + Math.floor((ts - TIME_START) / 1000);
  }, 0);

  return {
    pairkey: row.pairkey,
    total_time: totalSeconds
  };
});

// Sắp xếp theo tổng thời gian tăng dần
mapRankList.sort((a, b) => a.total_time - b.total_time);

let mapRank = mapRankList.findIndex(r => r.pairkey === pairkey) + 1 || null;
        ranking.map_rank = mapRank;
      }
    }

    // 5️⃣ Trả kết quả
    return res.json({
      status: "success",
      planet_id,
      stage,
      ranking,
      sameBranch,
      otherBranch
    });
  } catch (err) {
    console.error("POST /api/available-planets error:", err);
    return res.status(500).json({ status: "error", message: "Server error" });
  } finally {
    client.release();
  }
});

// =============================
// HEALTHCHECK
// =============================
app.get("/", (_req, res) => res.send("✅ Teambuilding backend running."));

// =============================
// START SERVER
// =============================
server.listen(APP_PORT, HOST, () => {
  console.log(`✅ Server running at http://${HOST}:${APP_PORT}`);
});
