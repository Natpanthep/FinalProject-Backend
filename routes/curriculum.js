const router = require('express').Router()
const db = require('../db')
const { auth, teacherOnly, managerOnly } = require('../middleware/auth')
const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// ── Public ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ca.cur_id,ca.cur_improve,ca.cur_year,ca.cud_name,c.description
       FROM curriculum_approve ca JOIN curriculum c ON c.cur_id=ca.cur_id
       WHERE ca.is_active=true ORDER BY c.cur_id,ca.cur_improve`
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/students/lookup', async (req, res) => {
  const { stid } = req.query
  if (!stid) return res.status(400).json({ error: 'stid required' })
  try {
    const r = await db.query(
      `SELECT s.stid,s.st_name,s.email,s.intake_year,ca.cud_name,ca.cur_id,ca.cur_improve
       FROM student s JOIN curriculum_approve ca ON ca.cur_id=s.cur_id AND ca.cur_improve=s.cur_improve
       WHERE s.stid=$1`, [stid]
    )
    if (!r.rows.length) return res.status(404).json({ error: 'ไม่พบรหัสนักศึกษาในระบบ' })
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ── Teacher ───────────────────────────────────────────────────
router.get('/teacher/courses', auth, async (req, res) => {
  const { semester } = req.query
  if (!semester) return res.status(400).json({ error: 'semester required' })
  try {
    const r = await db.query(
      `SELECT c.course_id,c.course_name,c.credits,c.year_level,c.semester_no,c.cur_id,c.cur_improve,ca.cud_name
       FROM course_teacher ct
       JOIN course c ON c.course_id=ct.course_id
       JOIN curriculum_approve ca ON ca.cur_id=c.cur_id AND ca.cur_improve=c.cur_improve
       WHERE ct.teacher_id=$1 AND ct.semester=$2 ORDER BY c.course_id`,
      [req.user.user_ref, semester]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/teacher/semesters', auth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT DISTINCT semester FROM course_teacher WHERE teacher_id=$1 ORDER BY semester DESC',
      [req.user.user_ref]
    )
    res.json(r.rows.map(x => x.semester))
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ── Manager: CRUD + PDF upload ────────────────────────────────

// รายการหลักสูตรทั้งหมด
router.get('/manage/all', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ca.*,c.cud_name AS cur_name,c.description,
              (SELECT COUNT(*) FROM plo WHERE cur_id=ca.cur_id AND cur_improve=ca.cur_improve) AS plo_count,
              (SELECT COUNT(*) FROM course WHERE cur_id=ca.cur_id AND cur_improve=ca.cur_improve) AS course_count
       FROM curriculum_approve ca JOIN curriculum c ON c.cur_id=ca.cur_id
       ORDER BY ca.cur_id,ca.cur_improve`
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// สร้างหลักสูตรใหม่
router.post('/manage', auth, managerOnly, async (req, res) => {
  const { cud_name, description, cur_year, cur_id: existing_cur_id } = req.body
  if (!cud_name || !cur_year) return res.status(400).json({ error: 'cud_name และ cur_year จำเป็น' })
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    let cur_id
    if (existing_cur_id) {
      cur_id = existing_cur_id
    } else {
      const r = await client.query(
        'INSERT INTO curriculum (cud_name,description) VALUES ($1,$2) RETURNING cur_id',
        [cud_name, description || null]
      )
      cur_id = r.rows[0].cur_id
    }
    const imp = (await client.query(
      'SELECT COALESCE(MAX(cur_improve),0)+1 AS next FROM curriculum_approve WHERE cur_id=$1', [cur_id]
    )).rows[0].next
    const r = await client.query(
      'INSERT INTO curriculum_approve (cur_id,cur_improve,cur_year,cud_name,is_active) VALUES ($1,$2,$3,$4,true) RETURNING *',
      [cur_id, imp, cur_year, cud_name]
    )
    await client.query('COMMIT')
    res.status(201).json({ ...r.rows[0], message: 'สร้างหลักสูตรสำเร็จ' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// แก้ไขหลักสูตร
router.put('/manage/:cur_id/:cur_improve', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  const { cud_name, cur_year, is_active, description } = req.body
  try {
    await db.query(
      'UPDATE curriculum_approve SET cud_name=$1,cur_year=$2,is_active=$3 WHERE cur_id=$4 AND cur_improve=$5',
      [cud_name, cur_year, is_active, cur_id, cur_improve]
    )
    if (description !== undefined)
      await db.query('UPDATE curriculum SET description=$1 WHERE cur_id=$2', [description, cur_id])
    res.json({ message: 'อัปเดตสำเร็จ' })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ปิดหลักสูตร
router.patch('/manage/:cur_id/:cur_improve/deactivate', auth, managerOnly, async (req, res) => {
  try {
    await db.query('UPDATE curriculum_approve SET is_active=false WHERE cur_id=$1 AND cur_improve=$2',
      [req.params.cur_id, req.params.cur_improve])
    res.json({ message: 'ปิดใช้งานสำเร็จ' })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ลบหลักสูตร (hard delete — ทำได้ก็ต่อเมื่อยังไม่มีนักศึกษาหรือวิชา)
router.delete('/manage/:cur_id/:cur_improve', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  try {
    const hasStudents = await db.query(
      'SELECT COUNT(*) FROM student WHERE cur_id=$1 AND cur_improve=$2', [cur_id, cur_improve]
    )
    if (parseInt(hasStudents.rows[0].count) > 0)
      return res.status(400).json({ error: 'ไม่สามารถลบได้ มีนักศึกษาสังกัดอยู่ ใช้ปิดใช้งานแทน' })
    await db.query('DELETE FROM curriculum_approve WHERE cur_id=$1 AND cur_improve=$2', [cur_id, cur_improve])
    // ถ้าไม่มี approve เหลือเลย ลบ curriculum หลักด้วย
    const remaining = await db.query('SELECT COUNT(*) FROM curriculum_approve WHERE cur_id=$1', [cur_id])
    if (parseInt(remaining.rows[0].count) === 0)
      await db.query('DELETE FROM curriculum WHERE cur_id=$1', [cur_id])
    res.json({ message: 'ลบหลักสูตรสำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── PLO CRUD ──────────────────────────────────────────────────
router.get('/manage/:cur_id/:cur_improve/plo', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM plo WHERE cur_id=$1 AND cur_improve=$2 ORDER BY plo_id',
      [req.params.cur_id, req.params.cur_improve]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.post('/manage/:cur_id/:cur_improve/plo', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  const { plo_id, plo_detail, target_pct } = req.body
  if (!plo_id || !plo_detail) return res.status(400).json({ error: 'plo_id และ plo_detail จำเป็น' })
  try {
    const r = await db.query(
      'INSERT INTO plo (cur_id,cur_improve,plo_id,plo_detail,target_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [cur_id, cur_improve, plo_id, plo_detail, target_pct || 60]
    )
    res.status(201).json(r.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/manage/plo/:pid', auth, managerOnly, async (req, res) => {
  const { plo_detail, target_pct } = req.body
  try {
    const r = await db.query(
      'UPDATE plo SET plo_detail=$1,target_pct=$2 WHERE pid=$3 RETURNING *',
      [plo_detail, target_pct, req.params.pid]
    )
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/manage/plo/:pid', auth, managerOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM plo WHERE pid=$1', [req.params.pid])
    res.json({ message: 'ลบ PLO สำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Course CRUD ───────────────────────────────────────────────
router.get('/manage/:cur_id/:cur_improve/courses', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.*,COUNT(cc.cc_id) AS clo_count FROM course c
       LEFT JOIN course_clo cc ON cc.course_id=c.course_id
       WHERE c.cur_id=$1 AND c.cur_improve=$2
       GROUP BY c.course_id ORDER BY c.year_level NULLS LAST,c.semester_no NULLS LAST,c.course_id`,
      [req.params.cur_id, req.params.cur_improve]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.post('/manage/:cur_id/:cur_improve/courses', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  const { course_id, course_name, credits, year_level, semester_no } = req.body
  if (!course_id || !course_name) return res.status(400).json({ error: 'course_id และ course_name จำเป็น' })
  try {
    const r = await db.query(
      `INSERT INTO course (course_id,course_name,credits,cur_id,cur_improve,year_level,semester_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [course_id, course_name, credits || 3, cur_id, cur_improve, year_level || null, semester_no || null]
    )
    res.status(201).json(r.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.put('/manage/courses/:course_id', auth, managerOnly, async (req, res) => {
  const { course_name, credits, year_level, semester_no } = req.body
  try {
    const r = await db.query(
      'UPDATE course SET course_name=$1,credits=$2,year_level=$3,semester_no=$4 WHERE course_id=$5 RETURNING *',
      [course_name, credits, year_level || null, semester_no || null, req.params.course_id]
    )
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/manage/courses/:course_id', auth, managerOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM course WHERE course_id=$1', [req.params.course_id])
    res.json({ message: 'ลบวิชาสำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── PDF Upload → AI parse ─────────────────────────────────────
// POST /api/curriculum/manage/parse-pdf
// อ่าน PDF มคอ.2 แล้วให้ Claude API สรุปข้อมูลหลักสูตร
router.post('/manage/parse-pdf', auth, managerOnly, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์ PDF' })
  try {
    const base64 = req.file.buffer.toString('base64')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 }
            },
            {
              type: 'text',
              text: `อ่านเอกสาร มคอ.2 นี้แล้วสรุปข้อมูลหลักสูตรออกมาเป็น JSON ดังนี้ ตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น:
{
  "cud_name": "ชื่อหลักสูตรย่อ เช่น CS-68",
  "description": "ชื่อหลักสูตรเต็ม",
  "cur_year": 2568,
  "plos": [
    { "plo_id": 1, "plo_detail": "ข้อความ PLO", "target_pct": 60 }
  ],
  "courses": [
    { "course_id": "CS1373", "course_name": "ชื่อวิชา", "credits": 3, "year_level": 1, "semester_no": 1 }
  ]
}`
            }
          ]
        }]
      })
    })
    const data = await response.json()
    const text = data.content?.map(c => c.text || '').join('') || ''
    // parse JSON จาก response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(422).json({ error: 'ไม่สามารถอ่านข้อมูลจาก PDF ได้', raw: text.slice(0, 500) })
    const parsed = JSON.parse(jsonMatch[0])
    res.json({ success: true, data: parsed })
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอ่าน PDF: ' + err.message })
  }
})

// ── PLO overview ──────────────────────────────────────────────
router.get('/manage/plo-overview', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.query
  try {
    const r = await db.query(
      `SELECT s.stid,s.st_name,s.intake_year,
              COUNT(DISTINCT p.pid) AS total_plo,
              COUNT(DISTINCT sps.pid) FILTER (WHERE sps.is_passed=true) AS passed_plo,
              ROUND(COUNT(DISTINCT sps.pid) FILTER (WHERE sps.is_passed=true)*100.0
                /NULLIF(COUNT(DISTINCT p.pid),0),1) AS completeness_pct
       FROM student s
       JOIN plo p ON p.cur_id=s.cur_id AND p.cur_improve=s.cur_improve
       LEFT JOIN student_plo_score sps ON sps.stid=s.stid AND sps.pid=p.pid
       WHERE ($1::int IS NULL OR s.cur_id=$1) AND ($2::int IS NULL OR s.cur_improve=$2)
       GROUP BY s.stid,s.st_name,s.intake_year ORDER BY completeness_pct DESC NULLS LAST`,
      [cur_id || null, cur_improve || null]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ── General ───────────────────────────────────────────────────
router.get('/:cur_id/:cur_improve/plan', auth, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  try {
    const r = await db.query('SELECT * FROM v_curriculum_plan WHERE cur_id=$1 AND cur_improve=$2', [cur_id, cur_improve])
    const plan = {}
    for (const row of r.rows) {
      const y = row.year_level ?? 'เลือก'; const s = row.semester_no ?? 'เลือก'
      if (!plan[y]) plan[y] = {}; if (!plan[y][s]) plan[y][s] = []
      plan[y][s].push(row)
    }
    res.json({ plan, raw: r.rows })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/:cur_id/:cur_improve/plo', auth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT pid,plo_id,plo_detail,target_pct FROM plo WHERE cur_id=$1 AND cur_improve=$2 ORDER BY plo_id',
      [req.params.cur_id, req.params.cur_improve]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/:cur_id/:cur_improve/courses', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT course_id,course_name,credits,year_level,semester_no FROM course
       WHERE cur_id=$1 AND cur_improve=$2
       ORDER BY year_level NULLS LAST,semester_no NULLS LAST,course_id`,
      [req.params.cur_id, req.params.cur_improve]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/courses/:course_id/clo', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT cc.cc_id,cc.clo_id,cc.clo_detail,
              json_agg(json_build_object('pid',p.pid,'plo_id',p.plo_id,'weight',cpm.weight))
              FILTER (WHERE p.pid IS NOT NULL) AS plo_links
       FROM course_clo cc
       LEFT JOIN clo_plo_mapping cpm ON cpm.cc_id=cc.cc_id AND cpm.is_active=true
       LEFT JOIN plo p ON p.pid=cpm.pid
       WHERE cc.course_id=$1 GROUP BY cc.cc_id,cc.clo_id,cc.clo_detail ORDER BY cc.clo_id`,
      [req.params.course_id]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router

// ── Manager: ผูกผู้บริหารกับหลักสูตรที่ดูแล ──────────────────

// GET /api/curriculum/manage/my-curricula — หลักสูตรที่ manager ดูแล
router.get('/manage/my-curricula', require('../middleware/auth').auth, require('../middleware/auth').managerOnly, async (req, res) => {
  try {
    // ถ้ายังไม่มีการ assign หลักสูตร คืนหลักสูตรทั้งหมด (สำหรับ super manager)
    // ในอนาคตสามารถ filter ตาม manager_curriculum_map ได้
    const r = await db.query(
      `SELECT ca.cur_id, ca.cur_improve, ca.cud_name, ca.cur_year, ca.is_active, c.description
       FROM curriculum_approve ca JOIN curriculum c ON c.cur_id=ca.cur_id
       ORDER BY ca.cur_id, ca.cur_improve`
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})
