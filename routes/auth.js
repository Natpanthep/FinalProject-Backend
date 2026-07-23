const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const db = require('../db')
const { auth } = require('../middleware/auth')

async function doLogin(email, password) {
  // ลำดับ: academic_affairs → curriculum_manager → teacher → student
  const acad = await db.query(
    "SELECT email,name FROM academic_affairs_profiles WHERE email=$1", [email]
  )
  if (acad.rows.length) {
    const au = await db.query(
      "SELECT password_hash FROM auth_users WHERE user_ref=$1 AND role='academic_affairs'", [email]
    )
    if (au.rows.length) return { user_ref: email, role: 'academic_affairs', display_name: acad.rows[0].name, hash: au.rows[0].password_hash }
  }
  const mgr = await db.query(
    "SELECT email,name FROM manager_profiles WHERE email=$1", [email]
  )
  if (mgr.rows.length) {
    const au = await db.query(
      "SELECT password_hash FROM auth_users WHERE user_ref=$1 AND role='curriculum_manager'", [email]
    )
    if (au.rows.length) return { user_ref: email, role: 'curriculum_manager', display_name: mgr.rows[0].name, hash: au.rows[0].password_hash }
  }
  const t = await db.query('SELECT teacher_id,teacher_name FROM teacher WHERE email=$1', [email])
  if (t.rows.length) {
    const id = String(t.rows[0].teacher_id)
    const au = await db.query("SELECT password_hash FROM auth_users WHERE user_ref=$1 AND role='teacher'", [id])
    if (au.rows.length) return { user_ref: id, role: 'teacher', display_name: t.rows[0].teacher_name, hash: au.rows[0].password_hash }
  }
  const s = await db.query('SELECT stid,st_name FROM student WHERE email=$1', [email])
  if (s.rows.length) {
    const au = await db.query("SELECT password_hash FROM auth_users WHERE user_ref=$1 AND role='student'", [s.rows[0].stid])
    if (au.rows.length) return { user_ref: s.rows[0].stid, role: 'student', display_name: s.rows[0].st_name, hash: au.rows[0].password_hash }
  }
  return null
}

router.post('/register/student', async (req, res) => {
  const { stid, email, password } = req.body
  if (!stid || !email || !password) return res.status(400).json({ error: 'stid, email และ password จำเป็น' })
  try {
    const s = await db.query('SELECT stid,st_name FROM student WHERE stid=$1', [stid])
    if (!s.rows.length) return res.status(404).json({ error: 'ไม่พบรหัสนักศึกษาในระบบ' })
    const dup = await db.query("SELECT id FROM auth_users WHERE user_ref=$1 AND role='student'", [stid])
    if (dup.rows.length) return res.status(409).json({ error: 'รหัสนักศึกษานี้ลงทะเบียนแล้ว' })
    await db.query('UPDATE student SET email=COALESCE(email,$1) WHERE stid=$2 AND email IS NULL', [email, stid])
    await db.query('INSERT INTO auth_users (user_ref,role,password_hash) VALUES ($1,$2,$3)',
      [stid, 'student', await bcrypt.hash(password, 10)])
    res.status(201).json({ message: 'ลงทะเบียนสำเร็จ', st_name: s.rows[0].st_name })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/register/teacher', async (req, res) => {
  const { teacher_name, email, password, department } = req.body
  if (!teacher_name || !email || !password) return res.status(400).json({ error: 'ชื่อ, email และ password จำเป็น' })
  try {
    const dup = await db.query('SELECT teacher_id FROM teacher WHERE email=$1', [email])
    if (dup.rows.length) return res.status(409).json({ error: 'Email นี้ใช้งานแล้ว' })
    const r = await db.query(
      'INSERT INTO teacher (teacher_name,email,department) VALUES ($1,$2,$3) RETURNING teacher_id',
      [teacher_name, email, department || null]
    )
    await db.query('INSERT INTO auth_users (user_ref,role,password_hash) VALUES ($1,$2,$3)',
      [String(r.rows[0].teacher_id), 'teacher', await bcrypt.hash(password, 10)])
    res.status(201).json({ message: 'ลงทะเบียนสำเร็จ' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/register/manager', async (req, res) => {
  const { name, email, password, department } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'ชื่อ, email และ password จำเป็น' })
  try {
    const dup = await db.query("SELECT id FROM auth_users WHERE user_ref=$1 AND role='curriculum_manager'", [email])
    if (dup.rows.length) return res.status(409).json({ error: 'Email นี้ใช้งานแล้ว' })
    await db.query('INSERT INTO manager_profiles (email,name,department) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET name=$2,department=$3',
      [email, name, department || null])
    await db.query('INSERT INTO auth_users (user_ref,role,password_hash) VALUES ($1,$2,$3)',
      [email, 'curriculum_manager', await bcrypt.hash(password, 10)])
    res.status(201).json({ message: 'ลงทะเบียนผู้รับผิดชอบหลักสูตรสำเร็จ' })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email และ password จำเป็น' })
  try {
    const found = await doLogin(email, password)
    if (!found) return res.status(401).json({ error: 'Email หรือรหัสผ่านไม่ถูกต้อง' })
    const ok = await bcrypt.compare(password, found.hash)
    if (!ok) return res.status(401).json({ error: 'Email หรือรหัสผ่านไม่ถูกต้อง' })
    const token = jwt.sign(
      { user_ref: found.user_ref, role: found.role, display_name: found.display_name, email },
      process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )
    res.json({ token, role: found.role, display_name: found.display_name, user_ref: found.user_ref, email })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

router.get('/me', auth, async (req, res) => {
  const { user_ref, role } = req.user
  try {
    if (role === 'student') {
      const r = await db.query(
        `SELECT s.*,ca.cud_name AS curriculum_name FROM student s
         LEFT JOIN curriculum_approve ca ON ca.cur_id=s.cur_id AND ca.cur_improve=s.cur_improve
         WHERE s.stid=$1`, [user_ref]
      )
      if (!r.rows.length) return res.status(404).json({ error: 'Student not found' })
      return res.json({ ...r.rows[0], role })
    }
    if (role === 'teacher') {
      const r = await db.query('SELECT * FROM teacher WHERE teacher_id=$1', [user_ref])
      return res.json({ ...r.rows[0], role })
    }
    if (role === 'academic_affairs') {
      const r = await db.query('SELECT * FROM academic_affairs_profiles WHERE email=$1', [user_ref])
      return res.json({ ...r.rows[0], role, email: user_ref })
    }
    const r = await db.query('SELECT * FROM manager_profiles WHERE email=$1', [user_ref])
    return res.json({ ...r.rows[0], role, email: user_ref })
  } catch (err) { res.status(500).json({ error: 'Server error' }) }
})

module.exports = router
