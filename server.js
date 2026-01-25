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
    // People table
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
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Relations (family members, connections to person)
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_relations (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        name TEXT NOT NULL,
        age INTEGER,
        notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
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
    
    // Follow-up items
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_followups (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
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
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_people_name ON crm_people(name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_notes_person ON crm_notes(person_id)`);
    
    console.log('CRM Database initialized');
  } finally {
    client.release();
  }
}

// Helper functions
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

// Get all people (summary)
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
  
  const relations = await queryAll('SELECT * FROM crm_relations WHERE person_id = $1', [req.params.id]);
  const notes = await queryAll('SELECT * FROM crm_notes WHERE person_id = $1 ORDER BY created_at DESC', [req.params.id]);
  const followups = await queryAll('SELECT * FROM crm_followups WHERE person_id = $1 AND completed = FALSE', [req.params.id]);
  const interactions = await queryAll('SELECT * FROM crm_interactions WHERE person_id = $1 ORDER BY date DESC LIMIT 10', [req.params.id]);
  
  res.json({ ...person, relations, notes, followups, interactions });
});

// Briefing endpoint - get everything needed before meeting someone
app.get('/api/briefing/:nameOrId', async (req, res) => {
  const param = req.params.nameOrId;
  let person;
  
  if (!isNaN(param)) {
    person = await queryOne('SELECT * FROM crm_people WHERE id = $1', [param]);
  } else {
    person = await queryOne('SELECT * FROM crm_people WHERE LOWER(name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1)', [`%${param}%`]);
  }
  
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  const relations = await queryAll('SELECT * FROM crm_relations WHERE person_id = $1', [person.id]);
  const recentNotes = await queryAll('SELECT * FROM crm_notes WHERE person_id = $1 ORDER BY created_at DESC LIMIT 5', [person.id]);
  const followups = await queryAll('SELECT * FROM crm_followups WHERE person_id = $1 AND completed = FALSE', [person.id]);
  const lastInteraction = await queryOne('SELECT * FROM crm_interactions WHERE person_id = $1 ORDER BY date DESC LIMIT 1', [person.id]);
  
  // Build briefing
  const briefing = {
    person: {
      name: person.name,
      nickname: person.nickname,
      relationship: person.relationship,
      how_we_met: person.how_we_met,
      location: person.location,
      company: person.company,
      job_title: person.job_title
    },
    family: relations.map(r => ({ type: r.relation_type, name: r.name, age: r.age, notes: r.notes })),
    recent_updates: recentNotes.map(n => ({ note: n.note, type: n.note_type, date: n.date || n.created_at })),
    follow_up_on: followups.map(f => f.item),
    last_interaction: lastInteraction ? { type: lastInteraction.interaction_type, date: lastInteraction.date, notes: lastInteraction.notes } : null
  };
  
  res.json(briefing);
});

// Add a new person
app.post('/api/people', async (req, res) => {
  const { name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, notes } = req.body;
  const result = await run(
    `INSERT INTO crm_people (name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Update a person
app.put('/api/people/:id', async (req, res) => {
  const { name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, notes } = req.body;
  await run(
    `UPDATE crm_people SET name=$1, nickname=$2, relationship=$3, how_we_met=$4, location=$5, birthday=$6, email=$7, phone=$8, company=$9, job_title=$10, notes=$11, updated_at=NOW() WHERE id=$12`,
    [name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, notes, req.params.id]
  );
  res.json({ success: true });
});

// Delete a person
app.delete('/api/people/:id', async (req, res) => {
  await run('DELETE FROM crm_people WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Add a relation to a person
app.post('/api/people/:id/relations', async (req, res) => {
  const { relation_type, name, age, notes } = req.body;
  const result = await run(
    'INSERT INTO crm_relations (person_id, relation_type, name, age, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.params.id, relation_type, name, age, notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Add a note about a person
app.post('/api/people/:id/notes', async (req, res) => {
  const { note, note_type, date } = req.body;
  const result = await run(
    'INSERT INTO crm_notes (person_id, note, note_type, date) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, note, note_type || 'general', date || getToday()]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Add a follow-up item
app.post('/api/people/:id/followups', async (req, res) => {
  const { item } = req.body;
  const result = await run(
    'INSERT INTO crm_followups (person_id, item) VALUES ($1, $2) RETURNING id',
    [req.params.id, item]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Complete a follow-up
app.put('/api/followups/:id/complete', async (req, res) => {
  await run('UPDATE crm_followups SET completed = TRUE, completed_at = NOW() WHERE id = $1', [req.params.id]);
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

// Search across everything
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  const people = await queryAll(
    `SELECT id, name, nickname, relationship FROM crm_people 
     WHERE LOWER(name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1) OR LOWER(notes) LIKE LOWER($1)`,
    [`%${q}%`]
  );
  
  res.json(people);
});

// Stats
app.get('/api/stats', async (req, res) => {
  const totalPeople = await queryOne('SELECT COUNT(*) as count FROM crm_people');
  const totalNotes = await queryOne('SELECT COUNT(*) as count FROM crm_notes');
  const pendingFollowups = await queryOne('SELECT COUNT(*) as count FROM crm_followups WHERE completed = FALSE');
  const recentInteractions = await queryOne('SELECT COUNT(*) as count FROM crm_interactions WHERE date >= $1', [getToday()]);
  
  res.json({
    total_people: parseInt(totalPeople.count),
    total_notes: parseInt(totalNotes.count),
    pending_followups: parseInt(pendingFollowups.count),
    interactions_today: parseInt(recentInteractions.count)
  });
});

// Start server
const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Personal CRM running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
