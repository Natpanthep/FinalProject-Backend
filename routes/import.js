const router = require('express').Router()
const db = require('../db')
const { auth, teacherOnly } = require('../middleware/auth')
const multer = require('multer')
const XLSX = require('xlsx')

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// ── POST /api/import/students  (ครูเท่านั้น) ─────────────────
// import นักศึกษาจาก Excel เข้า student table
// คอลัมน์: stid, st_name, email(optional), cur_id, cur_improve, intake_year
router.post('/students', auth, teacherOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' })
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })

    const required = ['stid', 'st_name', 'cur_id', 'cur_improve', 'intake_year']
    const missing = required.filter(k => !rows[0]?.hasOwnProperty(k))
    if (missing.length) {
      return res.status(400).json({ error: `คอลัมน์ที่ขาด: ${missing.join(', ')}` })
    }

    const client = await db.getClient()
    const results = { inserted: 0, updated: 0, errors: [] }

    try {
      await client.query('BEGIN')
      for (const row of rows) {
        try {
          await client.query(
            `INSERT INTO student (stid, st_name, email, cur_id, cur_improve, intake_year)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (stid) DO UPDATE
               SET st_name=EXCLUDED.st_name,
                   email=COALESCE(EXCLUDED.email, student.email),
                   cur_id=EXCLUDED.cur_id,
                   cur_improve=EXCLUDED.cur_improve,
                   intake_year=EXCLUDED.intake_year`,
            [
              String(row.stid).trim(),
              String(row.st_name).trim(),
              row.email ? String(row.email).trim() : null,
              Number(row.cur_id),
              Number(row.cur_improve),
              Number(row.intake_year)
            ]
          )
          results.inserted++
        } catch (e) {
          results.errors.push({ stid: row.stid, error: e.message })
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({ message: 'Import สำเร็จ', ...results, total: rows.length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'เกิดข้อผิดพลาด: ' + err.message })
  }
})

// ── POST /api/import/scores  (ครูเท่านั้น) ───────────────────
// import คะแนนจาก Excel
// คอลัมน์: stid, item_id, score_given
// หรือ: stid, course_id, clo_id, item_title, score_given, max_score, weight_pct, semester
router.post('/scores', auth, teacherOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' })
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })

    const client = await db.getClient()
    const results = { inserted: 0, errors: [] }

    try {
      await client.query('BEGIN')

      for (const row of rows) {
        try {
          let item_id = row.item_id ? Number(row.item_id) : null

          // ถ้าไม่มี item_id ให้ค้นหาหรือสร้างจาก course_id + clo_id + item_title
          if (!item_id && row.course_id && row.clo_id && row.item_title) {
            const ccRes = await client.query(
              'SELECT cc_id FROM course_clo WHERE course_id=$1 AND clo_id=$2',
              [String(row.course_id).trim(), Number(row.clo_id)]
            )
            if (!ccRes.rows.length) {
              results.errors.push({ row: row.stid, error: `ไม่พบ CLO ${row.clo_id} ในวิชา ${row.course_id}` })
              continue
            }
            const cc_id = ccRes.rows[0].cc_id
            // หาหรือสร้าง assessment_item
            const aiRes = await client.query(
              `SELECT item_id FROM assessment_items WHERE cc_id=$1 AND title=$2 AND semester=$3`,
              [cc_id, String(row.item_title).trim(), String(row.semester || '').trim()]
            )
            if (aiRes.rows.length) {
              item_id = aiRes.rows[0].item_id
            } else {
              const newAI = await client.query(
                `INSERT INTO assessment_items
                 (cc_id, title, item_type, max_score, weight_pct, semester, created_by, is_active)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING item_id`,
                [
                  cc_id,
                  String(row.item_title).trim(),
                  row.item_type || 'exam',
                  Number(row.max_score) || 100,
                  Number(row.weight_pct) || 100,
                  String(row.semester || '').trim(),
                  req.user.user_ref
                ]
              )
              item_id = newAI.rows[0].item_id
            }
          }

          if (!item_id) {
            results.errors.push({ row: row.stid, error: 'ไม่พบ item_id' })
            continue
          }

          await client.query(
            `INSERT INTO student_scores (stid, item_id, score_given, graded_by)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (stid, item_id) DO UPDATE
               SET score_given=$3, graded_by=$4, graded_at=NOW()`,
            [String(row.stid).trim(), item_id, Number(row.score_given), req.user.user_ref]
          )
          results.inserted++
        } catch (e) {
          results.errors.push({ row: row.stid, error: e.message })
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }

    res.json({ message: 'Import คะแนนสำเร็จ', ...results, total: rows.length })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'เกิดข้อผิดพลาด: ' + err.message })
  }
})

// ── GET /api/import/template/:type  — ดาวน์โหลด template Excel ──
router.get('/template/:type', auth, teacherOnly, (req, res) => {
  const { type } = req.params
  let data, filename

  if (type === 'students') {
    data = [
      { stid: '66010001', st_name: 'นายตัวอย่าง ทดสอบ', email: 'test@hcu.ac.th',
        cur_id: 1, cur_improve: 2, intake_year: 2566 },
      { stid: '66010002', st_name: 'นางสาวตัวอย่าง ระบบ', email: '',
        cur_id: 1, cur_improve: 2, intake_year: 2566 }
    ]
    filename = 'template_students.xlsx'
  } else if (type === 'scores') {
    data = [
      { stid: '66010001', course_id: 'CS1373', clo_id: 1,
        item_title: 'Midterm Exam', item_type: 'exam',
        max_score: 100, weight_pct: 40, semester: '1/2568', score_given: 75 },
      { stid: '66010002', course_id: 'CS1373', clo_id: 1,
        item_title: 'Midterm Exam', item_type: 'exam',
        max_score: 100, weight_pct: 40, semester: '1/2568', score_given: 82 }
    ]
    filename = 'template_scores.xlsx'
  } else {
    return res.status(400).json({ error: 'type ต้องเป็น students หรือ scores' })
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(data)
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.send(buf)
})

module.exports = router
