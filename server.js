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

function calculateAge(birthday) {
  if (!birthday) return null;
  const today = new Date();
  const birth = new Date(birthday);
  if (isNaN(birth.getTime())) return null;
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

async function initDb() {
  const client = await pool.connect();
  try {
    // People table
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_people (
        id SERIAL PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name TEXT,
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
        photo_url TEXT,
        hidden_from_solar BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Add photo_url if not exists
    await client.query(`ALTER TABLE crm_people ADD COLUMN IF NOT EXISTS photo_url TEXT`);
    await client.query(`ALTER TABLE crm_people ADD COLUMN IF NOT EXISTS hidden_from_solar BOOLEAN DEFAULT false`);
    
    // Relations - lightweight for kids, etc.
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
    await client.query(`ALTER TABLE crm_relations ADD COLUMN IF NOT EXISTS related_person_id INTEGER REFERENCES crm_people(id) ON DELETE SET NULL`);
    
    // Notes
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
    
    // Interactions
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
    
    // Meetings
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
    
    // Groups
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Person-Groups junction
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_person_groups (
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES crm_groups(id) ON DELETE CASCADE,
        PRIMARY KEY (person_id, group_id)
      )
    `);
    
    // Important dates
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_important_dates (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        date_type TEXT NOT NULL,
        date TEXT NOT NULL,
        label TEXT,
        recurring BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Gift ideas
    await client.query(`
      CREATE TABLE IF NOT EXISTS crm_gift_ideas (
        id SERIAL PRIMARY KEY,
        person_id INTEGER REFERENCES crm_people(id) ON DELETE CASCADE,
        idea TEXT NOT NULL,
        occasion TEXT,
        price_range TEXT,
        link TEXT,
        purchased BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_people_first_name ON crm_people(first_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_people_last_name ON crm_people(last_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_notes_person ON crm_notes(person_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_meetings_person ON crm_meetings(person_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_meetings_date ON crm_meetings(meeting_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_crm_interactions_date ON crm_interactions(date)`);
    
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

// Helper to get full name
function fullName(person) {
  return [person.first_name, person.last_name].filter(Boolean).join(' ');
}

// ============ API Routes ============

// Get all people
app.get('/api/people', async (req, res) => {
  const search = req.query.search;
  let people;
  if (search) {
    people = await queryAll(
      `SELECT *, CONCAT(first_name, ' ', COALESCE(last_name, '')) as full_name FROM crm_people 
       WHERE LOWER(first_name) LIKE LOWER($1) OR LOWER(last_name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1)
       ORDER BY first_name, last_name`,
      [`%${search}%`]
    );
  } else {
    people = await queryAll('SELECT *, CONCAT(first_name, \' \', COALESCE(last_name, \'\')) as full_name FROM crm_people ORDER BY first_name, last_name');
  }
  res.json(people);
});

// Get single person with all details
app.get('/api/people/:id', async (req, res) => {
  const person = await queryOne('SELECT *, CONCAT(first_name, \' \', COALESCE(last_name, \'\')) as full_name FROM crm_people WHERE id = $1', [req.params.id]);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  // Calculate age
  person.age = calculateAge(person.birthday);
  
  // Get relations with linked person details
  const relations = await queryAll(`
    SELECT r.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as linked_name, p.id as linked_id 
    FROM crm_relations r 
    LEFT JOIN crm_people p ON r.related_person_id = p.id 
    WHERE r.person_id = $1
  `, [req.params.id]);
  
  // Get reverse relations
  const reverseRelations = await queryAll(`
    SELECT r.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as from_name, p.id as from_id,
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
  const groups = await queryAll(`
    SELECT g.* FROM crm_groups g 
    JOIN crm_person_groups pg ON g.id = pg.group_id 
    WHERE pg.person_id = $1
  `, [req.params.id]);
  const importantDates = await queryAll('SELECT * FROM crm_important_dates WHERE person_id = $1 ORDER BY date', [req.params.id]);
  const giftIdeas = await queryAll('SELECT * FROM crm_gift_ideas WHERE person_id = $1 ORDER BY purchased, created_at DESC', [req.params.id]);
  
  res.json({ ...person, relations, reverseRelations, notes, interactions, meetings, groups, importantDates, giftIdeas });
});

// Briefing endpoint
app.get('/api/briefing/:nameOrId', async (req, res) => {
  const param = req.params.nameOrId;
  let person;
  
  if (!isNaN(param)) {
    person = await queryOne('SELECT *, CONCAT(first_name, \' \', COALESCE(last_name, \'\')) as full_name FROM crm_people WHERE id = $1', [param]);
  } else {
    person = await queryOne(`
      SELECT *, CONCAT(first_name, ' ', COALESCE(last_name, '')) as full_name FROM crm_people 
      WHERE LOWER(first_name) LIKE LOWER($1) OR LOWER(last_name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1)
    `, [`%${param}%`]);
  }
  
  if (!person) return res.status(404).json({ error: 'Person not found' });
  
  const relations = await queryAll(`
    SELECT r.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as linked_name, p.birthday as linked_birthday
    FROM crm_relations r 
    LEFT JOIN crm_people p ON r.related_person_id = p.id 
    WHERE r.person_id = $1
  `, [person.id]);
  
  const recentNotes = await queryAll('SELECT * FROM crm_notes WHERE person_id = $1 ORDER BY created_at DESC LIMIT 5', [person.id]);
  const lastInteraction = await queryOne('SELECT * FROM crm_interactions WHERE person_id = $1 ORDER BY date DESC LIMIT 1', [person.id]);
  const giftIdeas = await queryAll('SELECT * FROM crm_gift_ideas WHERE person_id = $1 AND purchased = false', [person.id]);
  const importantDates = await queryAll('SELECT * FROM crm_important_dates WHERE person_id = $1', [person.id]);
  
  const briefing = {
    person: {
      id: person.id,
      first_name: person.first_name,
      last_name: person.last_name,
      full_name: person.full_name,
      nickname: person.nickname,
      age: calculateAge(person.birthday),
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
    last_interaction: lastInteraction ? { type: lastInteraction.interaction_type, date: lastInteraction.date, notes: lastInteraction.notes } : null,
    gift_ideas: giftIdeas.map(g => ({ idea: g.idea, occasion: g.occasion })),
    important_dates: importantDates.map(d => ({ type: d.date_type, date: d.date, label: d.label }))
  };
  
  res.json(briefing);
});

// Add a new person
app.post('/api/people', async (req, res) => {
  const { first_name, last_name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, photo_url } = req.body;
  const result = await run(
    `INSERT INTO crm_people (first_name, last_name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, photo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [first_name, last_name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, photo_url]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// Update a person
app.put('/api/people/:id', async (req, res) => {
  const { first_name, last_name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, photo_url } = req.body;
  await run(
    `UPDATE crm_people SET first_name=$1, last_name=$2, nickname=$3, relationship=$4, how_we_met=$5, location=$6, birthday=$7, email=$8, phone=$9, company=$10, job_title=$11, school=$12, notes=$13, photo_url=$14, updated_at=NOW() WHERE id=$15`,
    [first_name, last_name, nickname, relationship, how_we_met, location, birthday, email, phone, company, job_title, school, notes, photo_url, req.params.id]
  );
  res.json({ success: true });
});

// Delete a person
app.delete('/api/people/:id', async (req, res) => {
  await run('DELETE FROM crm_people WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Relations ============

app.post('/api/people/:id/relations', async (req, res) => {
  const { relation_type, name, related_person_id, age, notes } = req.body;
  const result = await run(
    'INSERT INTO crm_relations (person_id, related_person_id, relation_type, name, age, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [req.params.id, related_person_id || null, relation_type, name, age, notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.put('/api/relations/:id', async (req, res) => {
  const { relation_type, name, related_person_id, age, notes } = req.body;
  await run(
    'UPDATE crm_relations SET relation_type=$1, name=$2, related_person_id=$3, age=$4, notes=$5 WHERE id=$6',
    [relation_type, name, related_person_id, age, notes, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/relations/:id', async (req, res) => {
  await run('DELETE FROM crm_relations WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Notes ============

app.post('/api/people/:id/notes', async (req, res) => {
  const { note, note_type, date } = req.body;
  const result = await run(
    'INSERT INTO crm_notes (person_id, note, note_type, date) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, note, note_type || 'general', date || getToday()]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.delete('/api/notes/:id', async (req, res) => {
  await run('DELETE FROM crm_notes WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Interactions ============

app.post('/api/people/:id/interactions', async (req, res) => {
  const { interaction_type, date, notes } = req.body;
  const result = await run(
    'INSERT INTO crm_interactions (person_id, interaction_type, date, notes) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, interaction_type, date || getToday(), notes]
  );
  res.json({ id: result.rows[0].id, success: true });
});

// ============ Meetings ============

app.get('/api/meetings', async (req, res) => {
  const meetings = await queryAll(`
    SELECT m.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as person_name 
    FROM crm_meetings m 
    LEFT JOIN crm_people p ON m.person_id = p.id 
    ORDER BY m.meeting_date DESC
  `);
  res.json(meetings);
});

app.post('/api/people/:id/meetings', async (req, res) => {
  const { title, meeting_date, location, summary, action_items, mood } = req.body;
  const result = await run(
    'INSERT INTO crm_meetings (person_id, title, meeting_date, location, summary, action_items, mood) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [req.params.id, title, meeting_date || getToday(), location, summary, action_items, mood]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.put('/api/meetings/:id', async (req, res) => {
  const { title, meeting_date, location, summary, action_items, mood } = req.body;
  await run(
    'UPDATE crm_meetings SET title=$1, meeting_date=$2, location=$3, summary=$4, action_items=$5, mood=$6 WHERE id=$7',
    [title, meeting_date, location, summary, action_items, mood, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/meetings/:id', async (req, res) => {
  await run('DELETE FROM crm_meetings WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Groups ============

app.get('/api/groups', async (req, res) => {
  const groups = await queryAll(`
    SELECT g.*, COUNT(pg.person_id) as member_count 
    FROM crm_groups g 
    LEFT JOIN crm_person_groups pg ON g.id = pg.group_id 
    GROUP BY g.id 
    ORDER BY g.name
  `);
  res.json(groups);
});

app.post('/api/groups', async (req, res) => {
  const { name, description } = req.body;
  const result = await run(
    'INSERT INTO crm_groups (name, description) VALUES ($1, $2) RETURNING id',
    [name, description]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.put('/api/groups/:id', async (req, res) => {
  const { name, description } = req.body;
  await run('UPDATE crm_groups SET name=$1, description=$2 WHERE id=$3', [name, description, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/groups/:id', async (req, res) => {
  await run('DELETE FROM crm_groups WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/groups/:id/members', async (req, res) => {
  const members = await queryAll(`
    SELECT p.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as full_name
    FROM crm_people p 
    JOIN crm_person_groups pg ON p.id = pg.person_id 
    WHERE pg.group_id = $1
    ORDER BY p.first_name
  `, [req.params.id]);
  res.json(members);
});

app.post('/api/people/:id/groups', async (req, res) => {
  const { group_id } = req.body;
  await run('INSERT INTO crm_person_groups (person_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, group_id]);
  res.json({ success: true });
});

app.delete('/api/people/:personId/groups/:groupId', async (req, res) => {
  await run('DELETE FROM crm_person_groups WHERE person_id = $1 AND group_id = $2', [req.params.personId, req.params.groupId]);
  res.json({ success: true });
});

// ============ Important Dates ============

app.post('/api/people/:id/dates', async (req, res) => {
  const { date_type, date, label, recurring } = req.body;
  const result = await run(
    'INSERT INTO crm_important_dates (person_id, date_type, date, label, recurring) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.params.id, date_type, date, label, recurring !== false]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.delete('/api/dates/:id', async (req, res) => {
  await run('DELETE FROM crm_important_dates WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Gift Ideas ============

app.post('/api/people/:id/gifts', async (req, res) => {
  const { idea, occasion, price_range, link } = req.body;
  const result = await run(
    'INSERT INTO crm_gift_ideas (person_id, idea, occasion, price_range, link) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.params.id, idea, occasion, price_range, link]
  );
  res.json({ id: result.rows[0].id, success: true });
});

app.put('/api/gifts/:id', async (req, res) => {
  const { idea, occasion, price_range, link, purchased } = req.body;
  await run(
    'UPDATE crm_gift_ideas SET idea=$1, occasion=$2, price_range=$3, link=$4, purchased=$5 WHERE id=$6',
    [idea, occasion, price_range, link, purchased, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/gifts/:id', async (req, res) => {
  await run('DELETE FROM crm_gift_ideas WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ============ Search & Stats ============

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  const people = await queryAll(
    `SELECT id, first_name, last_name, CONCAT(first_name, ' ', COALESCE(last_name, '')) as full_name, nickname, relationship, company 
     FROM crm_people 
     WHERE LOWER(first_name) LIKE LOWER($1) OR LOWER(last_name) LIKE LOWER($1) OR LOWER(nickname) LIKE LOWER($1) OR LOWER(company) LIKE LOWER($1)`,
    [`%${q}%`]
  );
  
  res.json(people);
});

app.get('/api/stats', async (req, res) => {
  const totalPeople = await queryOne('SELECT COUNT(*) as count FROM crm_people');
  const totalNotes = await queryOne('SELECT COUNT(*) as count FROM crm_notes');
  const totalRelations = await queryOne('SELECT COUNT(*) as count FROM crm_relations');
  const totalMeetings = await queryOne('SELECT COUNT(*) as count FROM crm_meetings');
  const totalGroups = await queryOne('SELECT COUNT(*) as count FROM crm_groups');
  const recentInteractions = await queryAll(`
    SELECT i.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as person_name 
    FROM crm_interactions i 
    LEFT JOIN crm_people p ON i.person_id = p.id
    ORDER BY i.date DESC LIMIT 5
  `);
  const recentMeetings = await queryAll(`
    SELECT m.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as person_name 
    FROM crm_meetings m 
    LEFT JOIN crm_people p ON m.person_id = p.id 
    ORDER BY m.meeting_date DESC LIMIT 5
  `);
  
  res.json({
    total_people: parseInt(totalPeople.count),
    total_notes: parseInt(totalNotes.count),
    total_relations: parseInt(totalRelations.count),
    total_meetings: parseInt(totalMeetings.count),
    total_groups: parseInt(totalGroups.count),
    recent_interactions: recentInteractions,
    recent_meetings: recentMeetings
  });
});

// Stale contacts - people not contacted in X days
app.get('/api/stale', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  
  const stale = await queryAll(`
    SELECT p.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as full_name,
           MAX(i.date) as last_interaction_date,
           MAX(m.meeting_date) as last_meeting_date
    FROM crm_people p
    LEFT JOIN crm_interactions i ON p.id = i.person_id
    LEFT JOIN crm_meetings m ON p.id = m.person_id
    GROUP BY p.id
    HAVING (MAX(i.date) IS NULL AND MAX(m.meeting_date) IS NULL)
        OR (GREATEST(COALESCE(MAX(i.date), '1970-01-01'), COALESCE(MAX(m.meeting_date), '1970-01-01')) < $1)
    ORDER BY GREATEST(COALESCE(MAX(i.date), '1970-01-01'), COALESCE(MAX(m.meeting_date), '1970-01-01'))
  `, [cutoffStr]);
  
  res.json(stale.map(p => ({
    ...p,
    last_contact: p.last_interaction_date > p.last_meeting_date ? p.last_interaction_date : p.last_meeting_date
  })));
});

// Upcoming birthdays (YYYY-MM-DD format)
app.get('/api/birthdays', async (req, res) => {
  const people = await queryAll(`
    SELECT id, first_name, last_name, CONCAT(first_name, ' ', COALESCE(last_name, '')) as full_name, birthday 
    FROM crm_people 
    WHERE birthday IS NOT NULL AND birthday != ''
  `);
  
  const today = new Date();
  const upcoming = people.filter(p => {
    if (!p.birthday) return false;
    const birth = new Date(p.birthday);
    if (isNaN(birth.getTime())) return false;
    const bday = new Date(today.getFullYear(), birth.getMonth(), birth.getDate());
    if (bday < today) bday.setFullYear(today.getFullYear() + 1);
    const daysUntil = Math.ceil((bday - today) / (1000 * 60 * 60 * 24));
    return daysUntil <= 30;
  }).map(p => {
    const birth = new Date(p.birthday);
    const bday = new Date(today.getFullYear(), birth.getMonth(), birth.getDate());
    if (bday < today) bday.setFullYear(today.getFullYear() + 1);
    return { 
      ...p, 
      age: calculateAge(p.birthday),
      days_until: Math.ceil((bday - today) / (1000 * 60 * 60 * 24)) 
    };
  }).sort((a, b) => a.days_until - b.days_until);
  
  res.json(upcoming);
});

// Upcoming important dates
app.get('/api/upcoming-dates', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const dates = await queryAll(`
    SELECT d.*, CONCAT(p.first_name, ' ', COALESCE(p.last_name, '')) as person_name
    FROM crm_important_dates d
    JOIN crm_people p ON d.person_id = p.id
  `);
  
  const today = new Date();
  const upcoming = dates.filter(d => {
    const date = new Date(d.date);
    if (isNaN(date.getTime())) return false;
    if (d.recurring) {
      date.setFullYear(today.getFullYear());
      if (date < today) date.setFullYear(today.getFullYear() + 1);
    }
    const daysUntil = Math.ceil((date - today) / (1000 * 60 * 60 * 24));
    return daysUntil >= 0 && daysUntil <= days;
  }).map(d => {
    const date = new Date(d.date);
    if (d.recurring) {
      date.setFullYear(today.getFullYear());
      if (date < today) date.setFullYear(today.getFullYear() + 1);
    }
    return { ...d, days_until: Math.ceil((date - today) / (1000 * 60 * 60 * 24)) };
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

// Toggle solar view visibility
app.post('/api/people/:id/toggle-solar', async (req, res) => {
  const person = await queryOne('SELECT hidden_from_solar FROM crm_people WHERE id = $1', [req.params.id]);
  const newValue = !person?.hidden_from_solar;
  await run('UPDATE crm_people SET hidden_from_solar = $1 WHERE id = $2', [newValue, req.params.id]);
  res.json({ hidden_from_solar: newValue, success: true });
});
