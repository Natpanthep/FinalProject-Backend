require('dotenv').config()
const express = require('express')
const cors = require('cors')
const db = require('./db')

const app = express()
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }))
app.use(express.json())

app.use('/api/auth',       require('./routes/auth'))
app.use('/api/plo',        require('./routes/plo'))
app.use('/api/assessment', require('./routes/assessment'))
app.use('/api/curriculum', require('./routes/curriculum'))
app.use('/api/import',     require('./routes/import'))

app.get('/api/health', (_, res) => res.json({ status: 'ok' }))

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id            SERIAL       PRIMARY KEY,
      user_ref      VARCHAR(100) NOT NULL,
      role          VARCHAR(30)  NOT NULL
                    CHECK (role IN ('student','teacher','curriculum_manager')),
      password_hash TEXT         NOT NULL,
      UNIQUE (user_ref, role)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS manager_profiles (
      email       VARCHAR(150) PRIMARY KEY,
      name        VARCHAR(150) NOT NULL,
      department  VARCHAR(150),
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS passing_criteria (
      criteria_id  SERIAL       PRIMARY KEY,
      cc_id        INT          NOT NULL REFERENCES course_clo(cc_id),
      item_id      INT          REFERENCES assessment_items(item_id),
      name         VARCHAR(200) NOT NULL,
      pass_score   NUMERIC(5,2) NOT NULL DEFAULT 60,
      description  TEXT,
      is_active    BOOLEAN      NOT NULL DEFAULT TRUE
    )
  `)
  console.log('DB tables ready')
}

const PORT = process.env.PORT || 5000
initDB()
  .then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1) })
