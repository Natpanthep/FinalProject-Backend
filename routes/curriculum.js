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
       FROM student s LEFT JOIN curriculum_approve ca ON ca.cur_id=s.cur_id AND ca.cur_improve=s.cur_improve
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
      `SELECT DISTINCT c.course_id,c.course_name,c.credits,c.year_level,c.semester_no,c.cur_id,c.cur_improve,ca.cud_name
       FROM course c
       JOIN curriculum_approve ca ON ca.cur_id=c.cur_id AND ca.cur_improve=c.cur_improve
       WHERE c.teacher_id=$1
         OR c.course_id IN (SELECT course_id FROM course_teacher WHERE teacher_id=$1 AND semester=$2)
       ORDER BY c.course_id`,
      [req.user.user_ref, semester]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.get('/teacher/semesters', auth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ct.semester,
              CAST(split_part(ct.semester,'/',1) AS int) AS semester_no,
              CAST(split_part(ct.semester,'/',2) AS int) AS academic_year,
              MIN(c.year_level) AS year_level
       FROM course_teacher ct
       JOIN course c ON c.course_id=ct.course_id
       WHERE ct.teacher_id=$1
       GROUP BY ct.semester
       ORDER BY ct.semester DESC`,
      [req.user.user_ref]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

// ── Manager: Static endpoints (must come before parameterized routes) ──
router.get('/manage/teachers', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT teacher_id, teacher_name, email, department FROM teacher ORDER BY teacher_name'
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

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

router.get('/manage/my-curricula', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ca.cur_id, ca.cur_improve, ca.cud_name, ca.cur_year, ca.is_active, c.description
       FROM curriculum_approve ca JOIN curriculum c ON c.cur_id=ca.cur_id
       ORDER BY ca.cur_id, ca.cur_improve`
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

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

router.post('/manage/parse-pdf', auth, managerOnly, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์ PDF' })
  try {
    const base64 = req.file.buffer.toString('base64')
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
            { type: 'text', text: `อ่านเอกสาร มคอ.2 นี้แล้วสรุปข้อมูลหลักสูตรออกมาเป็น JSON ดังนี้ ตอบเป็น JSON เท่านั้น ไม่ต้องมีข้อความอื่น:
{"cud_name":"ชื่อหลักสูตรย่อ","description":"ชื่อหลักสูตรเต็ม","cur_year":2568,
"plos":[{"plo_id":1,"plo_detail":"ข้อความ PLO","target_pct":60}],
"courses":[{"course_id":"CS1373","course_name":"ชื่อวิชา","credits":3,"year_level":1,"semester_no":1}]}` }
          ]
        }]
      })
    })
    const data = await response.json()
    const text = data.content?.map(c => c.text || '').join('') || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return res.status(422).json({ error: 'ไม่สามารถอ่านข้อมูลจาก PDF ได้', raw: text.slice(0,500) })
    res.json({ success: true, data: JSON.parse(jsonMatch[0]) })
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอ่าน PDF: ' + err.message }) }
})

// ── Manager: Auto-register student in curriculum courses ──────
router.post('/manage/students/:stid/auto-register', auth, managerOnly, async (req, res) => {
  const { stid } = req.params
  try {
    const sResult = await db.query('SELECT cur_id, cur_improve, intake_year FROM student WHERE stid=$1', [stid])
    if (!sResult.rows.length) return res.status(404).json({ error: 'ไม่พบนักศึกษา' })
    const { cur_id, cur_improve, intake_year } = sResult.rows[0]
    const courses = await db.query(
      'SELECT course_id, year_level, semester_no FROM course WHERE cur_id=$1 AND cur_improve=$2',
      [cur_id, cur_improve]
    )
    let registered = 0
    for (const c of courses.rows) {
      const yr = intake_year && c.year_level ? Number(intake_year) + Number(c.year_level) - 1 : null
      const sem = c.semester_no && yr ? `${c.semester_no}/${yr}` : null
      try {
        await db.query(
          `INSERT INTO register (stid,course_id,semester,academic_year) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [stid, c.course_id, sem, yr]
        )
        registered++
      } catch {}
    }
    res.json({ message: `ลงทะเบียน ${registered} วิชาให้ ${stid} สำเร็จ`, registered })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Manager: PLO CRUD (SPECIFIC — must come before /:cur_id/:cur_improve) ──
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
  const pid = req.params.pid
  try {
    await db.query('DELETE FROM clo_plo_mapping WHERE pid=$1', [pid])
    await db.query('DELETE FROM student_plo_score WHERE pid=$1', [pid])
    await db.query('DELETE FROM plo WHERE pid=$1', [pid])
    res.json({ message: 'ลบ PLO สำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Manager: Course CRUD (SPECIFIC — must come before /:cur_id/:cur_improve) ──
router.get('/manage/courses/:course_id/plo', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT pid FROM course_plo_map WHERE course_id=$1', [req.params.course_id]
    )
    res.json(r.rows.map(x => x.pid))
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.put('/manage/courses/:course_id/plo', auth, managerOnly, async (req, res) => {
  const { pids } = req.body
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM course_plo_map WHERE course_id=$1', [req.params.course_id])
    if (Array.isArray(pids)) {
      for (const pid of pids) {
        await client.query(
          'INSERT INTO course_plo_map (course_id,pid) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.course_id, pid]
        )
      }
    }
    await client.query('COMMIT')
    res.json({ message: 'บันทึก PLO สำเร็จ' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

router.put('/manage/courses/:course_id', auth, managerOnly, async (req, res) => {
  const { course_name, credits, year_level, semester_no, teacher_id } = req.body
  try {
    const r = await db.query(
      'UPDATE course SET course_name=$1,credits=$2,year_level=$3,semester_no=$4,teacher_id=$5 WHERE course_id=$6 RETURNING *',
      [course_name, credits, year_level || null, semester_no || null, teacher_id || null, req.params.course_id]
    )
    res.json(r.rows[0])
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/manage/courses/:course_id', auth, managerOnly, async (req, res) => {
  const { course_id } = req.params
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    await client.query(`DELETE FROM student_component_scores WHERE component_id IN
      (SELECT component_id FROM score_components WHERE course_id=$1)`, [course_id])
    await client.query(`DELETE FROM component_clo_map WHERE component_id IN
      (SELECT component_id FROM score_components WHERE course_id=$1)
      OR cc_id IN (SELECT cc_id FROM course_clo WHERE course_id=$1)`, [course_id])
    await client.query(`DELETE FROM assessment_items WHERE cc_id IN
      (SELECT cc_id FROM course_clo WHERE course_id=$1)`, [course_id])
    await client.query(`DELETE FROM passing_criteria WHERE cc_id IN
      (SELECT cc_id FROM course_clo WHERE course_id=$1)`, [course_id])
    await client.query(`DELETE FROM clo_plo_mapping WHERE cc_id IN
      (SELECT cc_id FROM course_clo WHERE course_id=$1)`, [course_id])
    await client.query('DELETE FROM score_components WHERE course_id=$1', [course_id])
    await client.query('DELETE FROM course_clo WHERE course_id=$1', [course_id])
    await client.query('DELETE FROM course_plo_map WHERE course_id=$1', [course_id])
    await client.query('DELETE FROM course_teacher WHERE course_id=$1', [course_id])
    await client.query('DELETE FROM register WHERE course_id=$1', [course_id])
    await client.query('DELETE FROM course WHERE course_id=$1', [course_id])
    await client.query('COMMIT')
    res.json({ message: 'ลบวิชาสำเร็จ' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// ── Manager: Curriculum CRUD (GENERIC parametric — after specific routes) ──
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

router.patch('/manage/:cur_id/:cur_improve/deactivate', auth, managerOnly, async (req, res) => {
  try {
    await db.query('UPDATE curriculum_approve SET is_active=false WHERE cur_id=$1 AND cur_improve=$2',
      [req.params.cur_id, req.params.cur_improve])
    res.json({ message: 'ปิดใช้งานสำเร็จ' })
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.delete('/manage/:cur_id/:cur_improve', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*) FROM student WHERE cur_id=$1 AND cur_improve=$2', [cur_id, cur_improve]
    )
    if (parseInt(count) > 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'ไม่สามารถลบได้ มีนักศึกษาสังกัดอยู่ ใช้ปิดใช้งานแทน' })
    }
    const p = [cur_id, cur_improve]
    await client.query(`DELETE FROM student_component_scores WHERE component_id IN (
      SELECT sc.component_id FROM score_components sc JOIN course c ON c.course_id=sc.course_id
      WHERE c.cur_id=$1 AND c.cur_improve=$2)`, p)
    await client.query(`DELETE FROM component_clo_map
      WHERE component_id IN (SELECT sc.component_id FROM score_components sc JOIN course c ON c.course_id=sc.course_id WHERE c.cur_id=$1 AND c.cur_improve=$2)
      OR cc_id IN (SELECT cc.cc_id FROM course_clo cc JOIN course c ON c.course_id=cc.course_id WHERE c.cur_id=$1 AND c.cur_improve=$2)`, p)
    await client.query(`DELETE FROM assessment_items WHERE cc_id IN (
      SELECT cc.cc_id FROM course_clo cc JOIN course c ON c.course_id=cc.course_id WHERE c.cur_id=$1 AND c.cur_improve=$2)`, p)
    await client.query(`DELETE FROM passing_criteria WHERE cc_id IN (
      SELECT cc.cc_id FROM course_clo cc JOIN course c ON c.course_id=cc.course_id WHERE c.cur_id=$1 AND c.cur_improve=$2)`, p)
    await client.query(`DELETE FROM clo_plo_mapping WHERE cc_id IN (
      SELECT cc.cc_id FROM course_clo cc JOIN course c ON c.course_id=cc.course_id WHERE c.cur_id=$1 AND c.cur_improve=$2)`, p)
    await client.query(`DELETE FROM score_components WHERE course_id IN (SELECT course_id FROM course WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM course_clo WHERE course_id IN (SELECT course_id FROM course WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM course_plo_map WHERE course_id IN (SELECT course_id FROM course WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM course_teacher WHERE course_id IN (SELECT course_id FROM course WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM register WHERE course_id IN (SELECT course_id FROM course WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query('DELETE FROM course WHERE cur_id=$1 AND cur_improve=$2', p)
    await client.query('DELETE FROM student_plo_score WHERE cur_id=$1 AND cur_improve=$2', p)
    await client.query(`DELETE FROM clo_plo_mapping WHERE pid IN (SELECT pid FROM plo WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM course_plo_map WHERE pid IN (SELECT pid FROM plo WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query(`DELETE FROM student_plo_score WHERE pid IN (SELECT pid FROM plo WHERE cur_id=$1 AND cur_improve=$2)`, p)
    await client.query('DELETE FROM plo WHERE cur_id=$1 AND cur_improve=$2', p)
    await client.query('DELETE FROM curriculum_approve WHERE cur_id=$1 AND cur_improve=$2', p)
    const rem = await client.query('SELECT COUNT(*) FROM curriculum_approve WHERE cur_id=$1', [cur_id])
    if (parseInt(rem.rows[0].count) === 0)
      await client.query('DELETE FROM curriculum WHERE cur_id=$1', [cur_id])
    await client.query('COMMIT')
    res.json({ message: 'ลบหลักสูตรสำเร็จ' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// ── Manager: PLO per curriculum ───────────────────────────────
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
  const { plo_detail, target_pct } = req.body
  if (!plo_detail) return res.status(400).json({ error: 'plo_detail จำเป็น' })
  try {
    const mx = await db.query(
      'SELECT COALESCE(MAX(plo_id),0)+1 AS next FROM plo WHERE cur_id=$1 AND cur_improve=$2',
      [cur_id, cur_improve]
    )
    const r = await db.query(
      'INSERT INTO plo (cur_id,cur_improve,plo_id,plo_detail,target_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [cur_id, cur_improve, mx.rows[0].next, plo_detail, target_pct || 60]
    )
    res.status(201).json(r.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Manager: Courses per curriculum ──────────────────────────
router.get('/manage/:cur_id/:cur_improve/courses', auth, managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.*,COUNT(cc.cc_id) AS clo_count,t.teacher_name,t.email AS teacher_email
       FROM course c
       LEFT JOIN course_clo cc ON cc.course_id=c.course_id
       LEFT JOIN teacher t ON t.teacher_id=c.teacher_id
       WHERE c.cur_id=$1 AND c.cur_improve=$2
       GROUP BY c.course_id,t.teacher_name,t.email ORDER BY c.year_level NULLS LAST,c.semester_no NULLS LAST,c.course_id`,
      [req.params.cur_id, req.params.cur_improve]
    )
    res.json(r.rows)
  } catch { res.status(500).json({ error: 'Server error' }) }
})

router.post('/manage/:cur_id/:cur_improve/courses', auth, managerOnly, async (req, res) => {
  const { cur_id, cur_improve } = req.params
  const { course_id, course_name, credits, year_level, semester_no, teacher_id } = req.body
  if (!course_id || !course_name) return res.status(400).json({ error: 'course_id และ course_name จำเป็น' })
  try {
    const r = await db.query(
      `INSERT INTO course (course_id,course_name,credits,cur_id,cur_improve,year_level,semester_no,teacher_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [course_id, course_name, credits || 3, cur_id, cur_improve, year_level || null, semester_no || null, teacher_id || null]
    )
    res.status(201).json(r.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/manage/:cur_id/:cur_improve/courses/import', auth, managerOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' })
  const XLSX = require('xlsx')
  const { cur_id, cur_improve } = req.params
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
    if (!rows.length) return res.status(400).json({ error: 'ไฟล์ว่างเปล่า' })

    // โหลด teacher map ทั้งหมดไว้ก่อน
    const tRows = await db.query('SELECT teacher_id, teacher_name FROM teacher')
    const teacherByName = {}
    for (const t of tRows.rows) teacherByName[t.teacher_name.trim().toLowerCase()] = t.teacher_id

    let saved = 0; const errors = []
    for (const row of rows) {
      const course_id   = String(row.course_id   || row['รหัสวิชา']   || '').trim()
      const course_name = String(row.course_name || row['ชื่อวิชา']   || '').trim()
      const credits     = Number(row.credits      || row['หน่วยกิต']  || 3)
      const year_level  = row.year_level  || row['ชั้นปี']    || null
      const semester_no = row.semester_no || row['ภาคการศึกษา'] || null
      if (!course_id || !course_name) { errors.push({ course_id, error: 'ขาด course_id หรือ course_name' }); continue }

      // หาอาจารย์: ลองจาก teacher_id ก่อน แล้วลอง teacher_name/อาจารย์
      let teacher_id = row.teacher_id ? Number(row.teacher_id) : null
      if (!teacher_id) {
        const tname = String(row.teacher_name || row['อาจารย์ผู้รับผิดชอบ'] || row['อาจารย์'] || '').trim()
        if (tname) teacher_id = teacherByName[tname.toLowerCase()] || null
      }

      try {
        await db.query(
          `INSERT INTO course (course_id,course_name,credits,cur_id,cur_improve,year_level,semester_no,teacher_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (course_id) DO UPDATE
             SET course_name=$2,credits=$3,cur_id=$4,cur_improve=$5,year_level=$6,semester_no=$7,teacher_id=$8`,
          [course_id, course_name, credits, cur_id, cur_improve,
           year_level ? Number(year_level) : null,
           semester_no ? Number(semester_no) : null,
           teacher_id || null]
        )
        saved++
      } catch (e) { errors.push({ course_id, error: e.message }) }
    }
    res.json({ message: `นำเข้า ${saved} วิชาสำเร็จ`, saved, errors, total: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
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

router.put('/courses/clo/:cc_id', auth, teacherOnly, async (req, res) => {
  const { clo_detail } = req.body
  if (!clo_detail) return res.status(400).json({ error: 'clo_detail จำเป็น' })
  try {
    await db.query('UPDATE course_clo SET clo_detail=$1 WHERE cc_id=$2', [clo_detail, req.params.cc_id])
    res.json({ message: 'อัพเดต CLO สำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
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

// CLO CRUD for teachers
router.post('/courses/:course_id/clo', auth, teacherOnly, async (req, res) => {
  const { clo_detail } = req.body
  if (!clo_detail) return res.status(400).json({ error: 'clo_detail จำเป็น' })
  try {
    const mx = await db.query(
      'SELECT COALESCE(MAX(clo_id),0)+1 AS next FROM course_clo WHERE course_id=$1',
      [req.params.course_id]
    )
    const r = await db.query(
      'INSERT INTO course_clo (course_id,clo_id,clo_detail) VALUES ($1,$2,$3) RETURNING *',
      [req.params.course_id, mx.rows[0].next, clo_detail]
    )
    res.status(201).json(r.rows[0])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.delete('/courses/clo/:cc_id', auth, teacherOnly, async (req, res) => {
  try {
    await db.query('DELETE FROM component_clo_map WHERE cc_id=$1', [req.params.cc_id])
    await db.query('DELETE FROM clo_plo_mapping WHERE cc_id=$1', [req.params.cc_id])
    await db.query('DELETE FROM course_clo WHERE cc_id=$1', [req.params.cc_id])
    res.json({ message: 'ลบ CLO สำเร็จ' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
