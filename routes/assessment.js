const router = require('express').Router()
const db = require('../db')
const { auth, teacherOnly } = require('../middleware/auth')
const multer = require('multer')
const XLSX = require('xlsx')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } })

// ── Score Components (ภาพรวมการให้คะแนน) ─────────────────────

// GET /api/assessment/components/:course_id?semester=
router.get('/components/:course_id', auth, async (req, res) => {
  const { semester } = req.query
  try {
    const params = [req.params.course_id]
    let semFilter = ''
    if (semester) { params.push(semester); semFilter = `AND sc.semester=$${params.length}` }
    const r = await db.query(
      `SELECT sc.*,
              json_agg(json_build_object(
                'cc_id', cc.cc_id, 'clo_id', cc.clo_id, 'clo_detail', cc.clo_detail
              ) ORDER BY cc.clo_id) FILTER (WHERE cc.cc_id IS NOT NULL) AS clos
       FROM score_components sc
       LEFT JOIN component_clo_map ccm ON ccm.component_id=sc.component_id
       LEFT JOIN course_clo cc ON cc.cc_id=ccm.cc_id
       WHERE sc.course_id=$1 AND sc.is_active=TRUE ${semFilter}
       GROUP BY sc.component_id
       ORDER BY sc.component_id`,
      params
    )
    res.json(r.rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/assessment/components  — สร้าง component + ผูก CLO
router.post('/components', auth, teacherOnly, async (req, res) => {
  const { course_id, semester, title, max_score, clo_ids } = req.body
  if (!course_id || !semester || !title || !max_score)
    return res.status(400).json({ error: 'course_id, semester, title, max_score จำเป็น' })
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    const r = await client.query(
      `INSERT INTO score_components (course_id, semester, title, max_score, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [course_id, semester, title, max_score, req.user.user_ref]
    )
    const comp = r.rows[0]
    // ผูก CLO
    if (Array.isArray(clo_ids) && clo_ids.length) {
      for (const cc_id of clo_ids) {
        await client.query(
          'INSERT INTO component_clo_map (component_id, cc_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [comp.component_id, cc_id]
        )
      }
    }
    await client.query('COMMIT')
    // return พร้อม CLO
    const full = await db.query(
      `SELECT sc.*,
              json_agg(json_build_object('cc_id',cc.cc_id,'clo_id',cc.clo_id,'clo_detail',cc.clo_detail)
              ORDER BY cc.clo_id) FILTER (WHERE cc.cc_id IS NOT NULL) AS clos
       FROM score_components sc
       LEFT JOIN component_clo_map ccm ON ccm.component_id=sc.component_id
       LEFT JOIN course_clo cc ON cc.cc_id=ccm.cc_id
       WHERE sc.component_id=$1 GROUP BY sc.component_id`,
      [comp.component_id]
    )
    res.status(201).json(full.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// PUT /api/assessment/components/:id
router.put('/components/:id', auth, teacherOnly, async (req, res) => {
  const { title, max_score, clo_ids } = req.body
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    const r = await client.query(
      'UPDATE score_components SET title=$1,max_score=$2 WHERE component_id=$3 RETURNING *',
      [title, max_score, req.params.id]
    )
    if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }) }
    // อัปเดต CLO mapping
    if (Array.isArray(clo_ids)) {
      await client.query('DELETE FROM component_clo_map WHERE component_id=$1', [req.params.id])
      for (const cc_id of clo_ids) {
        await client.query(
          'INSERT INTO component_clo_map (component_id, cc_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.id, cc_id]
        )
      }
    }
    await client.query('COMMIT')
    res.json(r.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// DELETE /api/assessment/components/:id
router.delete('/components/:id', auth, teacherOnly, async (req, res) => {
  try {
    await db.query('UPDATE score_components SET is_active=FALSE WHERE component_id=$1', [req.params.id])
    res.json({ message: 'Deactivated' })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Student Scores (กรอกคะแนน) ───────────────────────────────

// GET /api/assessment/scores/:course_id?semester=
// คืนคะแนนทุกคนในวิชา (สำหรับอาจารย์)
router.get('/scores/:course_id', auth, teacherOnly, async (req, res) => {
  const { semester } = req.query
  if (!semester) return res.status(400).json({ error: 'semester required' })
  try {
    // ดึง components ของวิชา+เทอม
    const comps = await db.query(
      `SELECT sc.component_id, sc.title, sc.max_score,
              json_agg(json_build_object('cc_id',cc.cc_id,'clo_id',cc.clo_id)
              ORDER BY cc.clo_id) FILTER (WHERE cc.cc_id IS NOT NULL) AS clos
       FROM score_components sc
       LEFT JOIN component_clo_map ccm ON ccm.component_id=sc.component_id
       LEFT JOIN course_clo cc ON cc.cc_id=ccm.cc_id
       WHERE sc.course_id=$1 AND sc.semester=$2 AND sc.is_active=TRUE
       GROUP BY sc.component_id ORDER BY sc.component_id`,
      [req.params.course_id, semester]
    )
    // ดึง student ในวิชา
    const students = await db.query(
      `SELECT s.stid, s.st_name FROM student s
       JOIN register r ON r.stid=s.stid
       WHERE r.course_id=$1 AND r.semester=$2 ORDER BY s.stid`,
      [req.params.course_id, semester]
    )
    // ดึงคะแนนที่มีอยู่
    const existingScores = await db.query(
      `SELECT scs.stid, scs.component_id, scs.score_given
       FROM student_component_scores scs
       JOIN score_components sc ON sc.component_id=scs.component_id
       WHERE sc.course_id=$1 AND sc.semester=$2`,
      [req.params.course_id, semester]
    )
    // สร้าง lookup: { stid: { component_id: score_given } }
    const scoreLookup = {}
    for (const row of existingScores.rows) {
      if (!scoreLookup[row.stid]) scoreLookup[row.stid] = {}
      scoreLookup[row.stid][row.component_id] = row.score_given
    }
    res.json({
      components: comps.rows,
      students: students.rows,
      scores: scoreLookup
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// POST /api/assessment/scores/bulk  — บันทึกคะแนนทีเดียวหลายคน
router.post('/scores/bulk', auth, teacherOnly, async (req, res) => {
  // scores = [{ stid, component_id, score_given }]
  const { scores } = req.body
  if (!Array.isArray(scores) || !scores.length)
    return res.status(400).json({ error: 'scores array required' })
  const client = await db.getClient()
  try {
    await client.query('BEGIN')
    let saved = 0
    for (const { stid, component_id, score_given } of scores) {
      if (!stid || !component_id || score_given === '' || score_given === undefined) continue
      // validate ไม่เกิน max_score
      const mx = await client.query('SELECT max_score FROM score_components WHERE component_id=$1', [component_id])
      if (mx.rows.length && Number(score_given) > mx.rows[0].max_score) continue
      await client.query(
        `INSERT INTO student_component_scores (stid, component_id, score_given, graded_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (stid, component_id) DO UPDATE
           SET score_given=$3, graded_by=$4, graded_at=NOW()`,
        [stid, component_id, Number(score_given), req.user.user_ref]
      )
      saved++
    }
    await client.query('COMMIT')
    res.json({ message: `บันทึก ${saved} คะแนน` })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: err.message })
  } finally { client.release() }
})

// ── CLO Summary (สำหรับ view นักศึกษา) ──────────────────────

// GET /api/assessment/clo-scores/:course_id?stid=&semester=
router.get('/clo-scores/:course_id', auth, async (req, res) => {
  const { stid, semester } = req.query
  if (!stid && req.user.role === 'student') {
    // นักศึกษาดูได้เฉพาะตัวเอง
    return res.status(403).json({ error: 'Access denied' })
  }
  try {
    const params = [req.params.course_id]
    let stidFilter = '', semFilter = ''
    if (stid)     { params.push(stid);     stidFilter = `AND scs.stid=$${params.length}` }
    if (semester) { params.push(semester); semFilter  = `AND sc.semester=$${params.length}` }

    // Simple view: คะแนนรวมต่อนักศึกษา
    const simple = await db.query(
      `SELECT scs.stid, s.st_name,
              SUM(scs.score_given) AS total_score,
              SUM(sc.max_score)    AS total_max,
              ROUND(SUM(scs.score_given)/NULLIF(SUM(sc.max_score),0)*100,2) AS score_pct
       FROM student_component_scores scs
       JOIN score_components sc ON sc.component_id=scs.component_id AND sc.is_active=TRUE ${semFilter}
       JOIN student s ON s.stid=scs.stid
       WHERE sc.course_id=$1 ${stidFilter}
       GROUP BY scs.stid, s.st_name ORDER BY s.stid`,
      params
    )

    // Detail view: CLO breakdown
    const detail = await db.query(
      `SELECT scs.stid, cc.clo_id, cc.clo_detail,
              sc.component_id, sc.title AS component_title, sc.max_score,
              scs.score_given,
              ROUND(scs.score_given/NULLIF(sc.max_score,0)*100,2) AS component_pct
       FROM student_component_scores scs
       JOIN score_components sc ON sc.component_id=scs.component_id AND sc.is_active=TRUE ${semFilter}
       JOIN component_clo_map ccm ON ccm.component_id=scs.component_id
       JOIN course_clo cc ON cc.cc_id=ccm.cc_id
       WHERE sc.course_id=$1 ${stidFilter}
       ORDER BY scs.stid, cc.clo_id, sc.component_id`,
      params
    )

    // components สำหรับแสดงโครงสร้างคะแนน
    const comps = await db.query(
      `SELECT sc.component_id, sc.title, sc.max_score,
              json_agg(json_build_object('clo_id',cc.clo_id,'cc_id',cc.cc_id)
              ORDER BY cc.clo_id) FILTER (WHERE cc.cc_id IS NOT NULL) AS clos
       FROM score_components sc
       LEFT JOIN component_clo_map ccm ON ccm.component_id=sc.component_id
       LEFT JOIN course_clo cc ON cc.cc_id=ccm.cc_id
       WHERE sc.course_id=$1 AND sc.is_active=TRUE ${semFilter}
       GROUP BY sc.component_id ORDER BY sc.component_id`,
      params
    )

    res.json({ simple: simple.rows, detail: detail.rows, components: comps.rows })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Import Excel ──────────────────────────────────────────────

// POST /api/assessment/import-scores
// Excel format: stid | component_title | score_given | course_id | semester
// หรือ: stid | component_id | score_given
router.post('/import-scores', auth, teacherOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' })
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
    if (!rows.length) return res.status(400).json({ error: 'ไฟล์ว่างเปล่า' })

    const client = await db.getClient()
    const results = { saved: 0, errors: [] }
    try {
      await client.query('BEGIN')
      for (const row of rows) {
        try {
          let component_id = row.component_id ? Number(row.component_id) : null
          // ถ้าไม่มี component_id ให้หาจาก course_id + semester + title
          if (!component_id && row.course_id && row.semester && row.component_title) {
            const c = await client.query(
              'SELECT component_id FROM score_components WHERE course_id=$1 AND semester=$2 AND title=$3 AND is_active=TRUE',
              [String(row.course_id).trim(), String(row.semester).trim(), String(row.component_title).trim()]
            )
            if (!c.rows.length) {
              results.errors.push({ stid: row.stid, error: `ไม่พบ component "${row.component_title}" ในวิชา ${row.course_id}` })
              continue
            }
            component_id = c.rows[0].component_id
          }
          if (!component_id) { results.errors.push({ stid: row.stid, error: 'ไม่พบ component_id' }); continue }
          const mx = await client.query('SELECT max_score FROM score_components WHERE component_id=$1', [component_id])
          const maxScore = mx.rows[0]?.max_score
          const val = Number(row.score_given)
          if (maxScore && val > maxScore) {
            results.errors.push({ stid: row.stid, error: `คะแนน ${val} เกิน max (${maxScore})` }); continue
          }
          await client.query(
            `INSERT INTO student_component_scores (stid, component_id, score_given, graded_by)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (stid, component_id) DO UPDATE
               SET score_given=$3, graded_by=$4, graded_at=NOW()`,
            [String(row.stid).trim(), component_id, val, req.user.user_ref]
          )
          results.saved++
        } catch (e) { results.errors.push({ stid: row.stid, error: e.message }) }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK'); throw e
    } finally { client.release() }

    res.json({ message: `Import สำเร็จ`, ...results, total: rows.length })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// GET /api/assessment/template/scores?course_id=&semester=
router.get('/template/scores', auth, teacherOnly, async (req, res) => {
  const { course_id, semester } = req.query
  try {
    let comps = []
    if (course_id && semester) {
      const r = await db.query(
        'SELECT title, component_id FROM score_components WHERE course_id=$1 AND semester=$2 AND is_active=TRUE ORDER BY component_id',
        [course_id, semester]
      )
      comps = r.rows
    }
    const students = course_id && semester ? await db.query(
      `SELECT s.stid, s.st_name FROM student s
       JOIN register r ON r.stid=s.stid
       WHERE r.course_id=$1 AND r.semester=$2 ORDER BY s.stid`,
      [course_id, semester]
    ) : { rows: [{ stid: '66010001', st_name: 'นายตัวอย่าง' }] }

    const data = []
    for (const s of students.rows) {
      if (comps.length) {
        for (const c of comps) {
          data.push({
            stid: s.stid, st_name: s.st_name,
            component_id: c.component_id,
            component_title: c.title,
            course_id: course_id || '', semester: semester || '',
            score_given: ''
          })
        }
      } else {
        data.push({
          stid: s.stid, st_name: s.st_name,
          component_id: '', component_title: 'ชื่อ component',
          course_id: course_id || 'CS1373', semester: semester || '1/2568',
          score_given: ''
        })
      }
    }

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(data)
    XLSX.utils.book_append_sheet(wb, ws, 'Scores')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Disposition', `attachment; filename="template_scores.xlsx"`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.send(buf)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── Legacy: assessment_items (ยังรองรับไว้ backward compat) ──
router.get('/items/:course_id', auth, async (req, res) => {
  const { semester } = req.query
  try {
    const params = [req.params.course_id]
    let extra = ''
    if (semester) { params.push(semester); extra = `AND ai.semester=$${params.length}` }
    const r = await db.query(
      `SELECT ai.*, cc.clo_id, cc.clo_detail
       FROM assessment_items ai
       JOIN course_clo cc ON cc.cc_id=ai.cc_id
       WHERE cc.course_id=$1 AND ai.is_active=TRUE ${extra}
       ORDER BY cc.clo_id, ai.item_id`,
      params
    )
    res.json(r.rows)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
