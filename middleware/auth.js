const jwt = require('jsonwebtoken')

const auth = (req, res, next) => {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' })
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET)
    next()
  } catch { return res.status(401).json({ error: 'Invalid token' }) }
}

const teacherOnly = (req, res, next) => {
  if (!['teacher','curriculum_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Teacher access required' })
  next()
}

const managerOnly = (req, res, next) => {
  if (!['curriculum_manager','academic_affairs'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager access required' })
  next()
}

const academicAffairsOnly = (req, res, next) => {
  if (req.user.role !== 'academic_affairs')
    return res.status(403).json({ error: 'Academic affairs access required' })
  next()
}

module.exports = { auth, teacherOnly, managerOnly, academicAffairsOnly }
