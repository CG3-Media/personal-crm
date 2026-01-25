const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function initDb() {
  const client = await pool.connect();
  try {
    // Drop old tables if schema changed significantly
    // await client.query('DROP TABLE IF EXISTS crm_followups, crm_relations, crm_notes, crm_interactions, crm_people CASCADE');
    
    // People table - comprehensive
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_people (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        nickname TEXT,
        relationship TEXT,
        how_we_met TEXT,
        location TEXT,
        birthday TEXT,
        email TEXT,
        phone TEXT,
        company TEXT,
        job_title TEXT,
        school TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Add columns if they don't exist (for existing tables)
    await client.query(`ALTER TABLE crm_people ADD COLUMN IF NOT EXISTS school TEXT`);
    
    // Relations - can link to another person
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_relations (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        related_person_id INTEGER REFERENCES crm_people(id) ON DELETE SET NULL,
        relation_type TEXT NOT NULL,
        name TEXT,
        age INTEGER,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Add related_person_id if doesn't exist
    await client.query(`ALTER TABLE crm_relations ADD COLUMN IF NOT EXISTS related_person_id INTEGER REFERENCES crm_people(id) ON DELETE SET NULL`);
    
    // Notes/updates about a person
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_notes (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        note_type TEXT DEFAULT 'general',
        date TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Interactions log
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_interactions (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        interaction_type TEXT,
        date TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Meetings - detailed meeting logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_meetings (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        title TEXT,
        meeting_date TEXT,
        location TEXT,
        summary TEXT,
        action_items TEXT,
        mood TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_people_name ON crm_people(name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_notes_person ON crm_notes(person_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_meetings_person ON crm_meetings(person_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_meetings_date ON crm_meetings(meeting_date)`);
    
    console.log('CRM Database initialized');
  } finally {
    client.release();
  }
}

async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function queryAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function run(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

// ============ API Routes ============

// Get all people
app.get('/api/people', async (req, res) => {
  const search = req.query.search;
  let people;
  if (search) {
    people = await queryAll(
      `SELECT * FROM crm_people WHERE LOWER(name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1) ORDER BY name`,
      [`%${search}%`]
    );
  } else {
    people = await queryAll('SELECT * FROM crm_people ORDER BY name');
  }
  res.json(people);
});

// Get single person with all details
app.get('/api/people/:id', async (req, res) => {
  const person = await queryOne('SELECT * FROM crm_people WHERE id = $1', [req.params.id]);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  // Get relations with linked person details
  const relations = await queryAll(`
    SELECT r.*, p.name as linked_name, p.id as linked_id 
    FROM crm_relations r 
    LEFT JOIN crm_people p ON r.related_person_id = p.id 
    WHERE r.person_id = $1
  `, [req.params.id]);
  
  // Get reverse relations (where this person is the related_person)
  const reverseRelations = await queryAll(`
    SELECT r.*, p.name as from_name, p.id as from_id,
           CASE r.relation_type 
             WHEN 'spouse' THEN 'spouse'
             WHEN 'child' THEN 'parent'
             WHEN 'parent' THEN 'child'
             WHEN 'sibling' THEN 'sibling'
             ELSE r.relation_type
           END as reverse_type
    FROM crm_relations r 
    JOIN crm_people p ON r.person_id = p.id 
    WHERE r.related_person_id = $1
  `, [req.params.id]);
  
  const notes = await queryAll('SELECT * FROM crm_notes WHERE person_id = $1 ORDER BY created_at DESC', [req.params.id]);
  const interactions = await queryAll('SELECT * FROM crm_interactions WHERE person_id = $1 ORDER BY date DESC LIMIT 10', [req.params.id]);
  const meetings = await queryAll('SELECT * FROM crm_meetings WHERE person_id = $1 ORDER BY meeting_date DESC', [req.params.id]);
  
  res.json({ ...person, relations, reverseRelations, notes, interactions, meetings });
});

// Briefing endpoint
app.get('/api/briefing/:nameOrId', async (req, res) => {
  const param = req.params.nameOrId;
  let person;
  
  if (!isNaN(param)) {
    person = await queryOne('SELECT * FROM crm_people WHERE id = $1', [param]);
  } else {
    person = await queryOne('SELECT * FROM crm_people WHERE LOWER(name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1)', [`%${param}%`]);
  }
  
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  // Get relations with linked person details
  const relations = await queryAll(`
    SELECT r.*, p.name as linked_name, p.birthday as linked_birthday
    FROM crm_relations r 
    LEFT JOIN crm_people p ON r.related_person_id = p.id 
    WHERE r.person_id = $1
  `, [person.id]);
  
  const recentNotes = await queryAll('SELECT * FROM crm_notes WHERE person_id = $1 ORDER BY created_at DESC LIMIT 5', [person.id]);
  const lastInteraction = await queryOne('SELECT * FROM crm_interactions WHERE person_id = $1 ORDER BY date DESC LIMIT 1', [person.id]);
  
  const briefing = {
    person: {
      name: person.name,
      nickname: person.nickname,
      relationship: person.relationship,
      how_we_met: person.how_we_met,
      location: person.location,
      birthday: person.birthday,
      company: person.company,
      job_title: person.job_title,
      school: person.school
    },
    family: relations.map(r => ({ 
      type: r.relation_type, 
      name: r.linked_name || r.name, 
      age: r.age, 
      birthday: r.linked_birthday,
      notes: r.notes,
      person_id: r.related_person_id
    })),
    recent_updates: recentNotes.map(n => ({ note: n.note, type: n.note_type, date: n.date || n.created_at })),
    last_interaction: lastInteraction ? { type: lastInteraction.interaction_type, date: lastInteraction.date, notes: lastInteraction.notes } : null
  };
  
  res.json(briefing);
});

// Add a new person
app.post('/api/people', async (req, res) => {
  const { name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes } = req.body;
  const result = await run(
    `INSERT INTO crm_people (name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Update a person
app.put('/api/people/:id', async (req, res) => {
  const { name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes } = req.body;
  await run(
    `UPDATE crm_people SET name=$1, nickname=$2, relationship=$3, how_we_met=$4, location=$5, birthday=$6, email=$7, phone=$8, company=$9, job_title=$10, school=$11, notes=$12, updated_at=NOW() WHERE id=$13`,
    [name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, req.params.id]
  );
  res.json({ success: true });
});

// Delete a person
app.delete('/api/people/:id', async (req, res) => {
  await run('DELETE FROM crm_people WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Add a relation (can link to existing person or just store name)
app.post('/api/people/:id/relations', async (req, res) => {
  const { relation_type, name, related_person_id, age, notes } = req.body;
  const result = await run(
    'INSERT INTO crm_relations (person_id, related_person_id, relation_type, name, age, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [req.params.id, related_person_id || null, relation_type, name, age, notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Update a relation
app.put('/api/relations/:id', async (req, res) => {
  const { relation_type, name, related_person_id, age, notes } = req.body;
  await run(
    'UPDATE crm_relations SET relation_type=$1, name=$2, related_person_id=$3, age=$4, notes=$5 WHERE id=$6',
    [relation_type, name, related_person_id, age, notes, req.params.id]
  );
  res.json({ success: true });
});

// Delete a relation
app.delete('/api/relations/:id', async (req, res) => {
  await run('DELETE FROM crm_relations WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Add a note
app.post('/api/people/:id/notes', async (req, res) => {
  const { note, note_type, date } = req.body;
  const result = await run(
    'INSERT INTO crm_notes (person_id, note, note_type, date) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, note, note_type || 'general', date || getToday()]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Delete a note
app.delete('/api/notes/:id', async (req, res) => {
  await run('DELETE FROM crm_notes WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Log an interaction
app.post('/api/people/:id/interactions', async (req, res) => {
  const { interaction_type, date, notes } = req.body;
  const result = await run(
    'INSERT INTO crm_interactions (person_id, interaction_type, date, notes) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, interaction_type, date || getToday(), notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// ============ Meetings ============

// Get all meetings
app.get('/api/meetings', async (req, res) => {
  const meetings = await queryAll(`
    SELECT m.*, p.name as person_name 
    FROM crm_meetings m 
    LEFT JOIN crm_people p ON m.person_id = p.id 
    ORDER BY m.meeting_date DESC
  `);
  res.json(meetings);
});

// Add a meeting
app.post('/api/people/:id/meetings', async (req, res) => {
  const { title, meeting_date, location, summary, action_items, mood } = req.body;
  const result = await run(
    'INSERT INTO crm_meetings (person_id, title, meeting_date, location, summary, action_items, mood) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [req.params.id, title, meeting_date || getToday(), location, summary, action_items, mood]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Update a meeting
app.put('/api/meetings/:id', async (req, res) => {
  const { title, meeting_date, location, summary, action_items, mood } = req.body;
  await run(
    'UPDATE crm_meetings SET title=$1, meeting_date=$2, location=$3, summary=$4, action_items=$5, mood=$6 WHERE id=$7',
    [title, meeting_date, location, summary, action_items, mood, req.params.id]
  );
  res.json({ success: true });
});

// Delete a meeting
app.delete('/api/meetings/:id', async (req, res) => {
  await run('DELETE FROM crm_meetings WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Search
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  const people = await queryAll(
    `SELECT id, name, nickname, relationship, company FROM crm_people 
     WHERE LOWER(name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1) OR LOWER(company) LIKE LOWER($1)`,
    [`%${q}%`]
  );
  
  res.json(people);
});

// Stats
app.get('/api/stats', async (req, res) => {
  const totalPeople = await queryOne('SELECT COUNT(*) as count FROM crm_people');
  const totalNotes = await queryOne('SELECT COUNT(*) as count FROM crm_notes');
  const totalRelations = await queryOne('SELECT COUNT(*) as count FROM crm_relations');
  const totalMeetings = await queryOne('SELECT COUNT(*) as count FROM crm_meetings');
  const recentInteractions = await queryAll('SELECT * FROM crm_interactions ORDER BY date DESC LIMIT 5');
  const recentMeetings = await queryAll(`
    SELECT m.*, p.name as person_name 
    FROM crm_meetings m 
    LEFT JOIN crm_people p ON m.person_id = p.id 
    ORDER BY m.meeting_date DESC LIMIT 5
  `);
  
  res.json({
    total_people: parseInt(totalPeople.count),
    total_notes: parseInt(totalNotes.count),
    total_relations: parseInt(totalRelations.count),
    total_meetings: parseInt(totalMeetings.count),
    recent_interactions: recentInteractions,
    recent_meetings: recentMeetings
  });
});

// Upcoming birthdays
app.get('/api/birthdays', async (req, res) => {
  // Get people with birthdays in the next 30 days
  const people = await queryAll(`
    SELECT id, name, birthday FROM crm_people 
    WHERE birthday IS NOT NULL AND birthday != ''
    ORDER BY birthday
  `);
  
  const today = new Date();
  const upcoming = people.filter(p => {
    if (!p.birthday) return false;
    const [month, day] = p.birthday.split('/').map(Number);
    if (!month || !day) return false;
    const bday = new Date(today.getFullYear(), month - 1, day);
    if (bday < today) bday.setFullYear(today.getFullYear() + 1);
    const daysUntil = Math.ceil((bday - today) / (1000 * 60 * 60 * 24));
    return daysUntil <= 30;
  }).map(p => {
    const [month, day] = p.birthday.split('/').map(Number);
    const bday = new Date(today.getFullYear(), month - 1, day);
    if (bday < today) bday.setFullYear(today.getFullYear() + 1);
    return { ...p, days_until: Math.ceil((bday - today) / (1000 * 60 * 60 * 24)) };
  }).sort((a, b) => a.days_until - b.days_until);
  
  res.json(upcoming);
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Personal CRM running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
