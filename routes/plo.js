const router = require('express').Router()
const db = require('../db')
const { auth } = require('../middleware/auth')

// GET /api/plo/student/:stid
router.get('/student/:stid', auth, async (req, res) => {
  const { stid } = req.params
  if (req.user.role === 'student' && req.user.user_ref !== stid)
    return res.status(403).json({ error: 'Access denied' })
  try {
    const sInfo = await db.query(
      `SELECT s.*, ca.cud_name AS curriculum_name
       FROM student s
       JOIN curriculum_approve ca ON ca.cur_id=s.cur_id AND ca.cur_improve=s.cur_improve
       WHERE s.stid=$1`, [stid]
    )
    if (!sInfo.rows.length) return res.status(404).json({ error: 'Student not found' })
    const student = sInfo.rows[0]

    const ploList = await db.query(
      `SELECT pid, plo_id, plo_detail, target_pct FROM plo
       WHERE cur_id=$1 AND cur_improve=$2 ORDER BY plo_id`,
      [student.cur_id, student.cur_improve]
    )

    // คำนวณ CLO score จาก v_student_clo_scores (ใช้ component-based)
    const cloScores = await db.query(
      `WITH clo_agg AS (
        SELECT vcs.cc_id, vcs.clo_id, vcs.course_id, vcs.clo_score
        FROM v_student_clo_scores vcs
        JOIN course c ON c.course_id=vcs.course_id
        WHERE vcs.stid=$1 AND c.cur_id=$2 AND c.cur_improve=$3
      )
      SELECT cpm.pid,
        COUNT(DISTINCT cpm.cc_id)                                       AS total_clo,
        COUNT(DISTINCT CASE WHEN ca.clo_score>=60 THEN cpm.cc_id END)  AS passed_clo,
        ROUND(
          COUNT(DISTINCT CASE WHEN ca.clo_score>=60 THEN cpm.cc_id END)::NUMERIC
          / NULLIF(COUNT(DISTINCT cpm.cc_id),0) * 100
        , 2) AS plo_pct
      FROM clo_plo_mapping cpm
      JOIN plo p ON p.pid=cpm.pid
      LEFT JOIN clo_agg ca ON ca.cc_id=cpm.cc_id
      WHERE p.cur_id=$2 AND p.cur_improve=$3 AND cpm.is_active=TRUE
      GROUP BY cpm.pid`,
      [stid, student.cur_id, student.cur_improve]
    )

    // join กับ ploList
    const pscMap = {}
    for (const row of cloScores.rows) pscMap[row.pid] = row

    const plo = ploList.rows.map(p => {
      const ps = pscMap[p.pid] || { total_clo:0, passed_clo:0, plo_pct:0 }
      return {
        ...p,
        total_clo:  Number(ps.total_clo),
        passed_clo: Number(ps.passed_clo),
        plo_pct:    Number(ps.plo_pct) || 0,
        is_passed:  (Number(ps.plo_pct) || 0) >= Number(p.target_pct)
      }
    })

    // CLO รายวิชา
    const cloByVicha = await db.query(
      `SELECT vcs.course_id, c.course_name, vcs.clo_id, cc.clo_detail,
              vcs.clo_score, vcs.clo_raw, vcs.clo_max, vcs.semester
       FROM v_student_clo_scores vcs
       JOIN course c ON c.course_id=vcs.course_id
       JOIN course_clo cc ON cc.cc_id=vcs.cc_id
       WHERE vcs.stid=$1 AND c.cur_id=$2 AND c.cur_improve=$3
       ORDER BY vcs.course_id, vcs.clo_id`,
      [stid, student.cur_id, student.cur_improve]
    )

    res.json({ student, plo, clo: cloByVicha.rows })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Server error' })
  }
})

// GET /api/plo/overview (teacher)
router.get('/overview', auth, async (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Teacher only' })
  try {
    const r = await db.query(
      `SELECT s.stid, s.st_name, s.email, s.intake_year, ca.cud_name,
              COUNT(DISTINCT r.course_id) AS courses_registered
       FROM student s
       JOIN curriculum_approve ca ON ca.cur_id=s.cur_id AND ca.cur_improve=s.cur_improve
       LEFT JOIN register r ON r.stid=s.stid
       GROUP BY s.stid, s.st_name, s.email, s.intake_year, ca.cud_name
       ORDER BY s.stid`
    )
    res.json(r.rows)
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
