import express from 'express';
import path from 'node:path';
import fs, { constants } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import cors from 'cors';
import cron from 'node-cron'; 
import { Resend } from 'resend'; 

// --- INITIAL SETUP ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

dotenv.config({
  path: path.join(__dirname, '.env'),
  quiet: true
});

const app = express();
const prisma = new PrismaClient();
app.use(express.json());
app.use(compression());
app.use(cors());

// =======================================================
// 🟢 CRITICAL FIX: Serve all files from the 'public' directory
app.use(express.static(PUBLIC_DIR));
// =======================================================

// --- JWT CONFIG ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET missing in .env');
  process.exit(1);
}

// --- OPENWEATHER CONFIG ---
const API_KEY = process.env.OPENWEATHER_API_KEY;
if (!API_KEY) {
  console.error("FATAL: OPENWEATHER_API_KEY environment variable is not set! Please check your .env file.");
  process.exit(1);
}

// --- RESEND CONFIG ---
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  console.warn('WARNING: RESEND_API_KEY missing in .env. Email alerts will be logged but not sent.');
}
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// --- SCHEDULING LOGIC ---

// --- FIXED LOCATION: New Delhi, India (for scheduled AQI checks) ---
const CHECK_LAT = 28.7041;
const CHECK_LON = 77.1025;
// -------------------------------------------------------------------

/** Checks AQI at the fixed location against the alert threshold and sends an email. */
async function checkAqiAndSendAlert(alert) {
    const { id, alertTime, threshold, alertEmail } = alert;

    // 1. Fetch User Data (only for logging and salutation)
    const alertWithUser = await prisma.alert.findUnique({ 
        where: { id: id },
        select: { 
            user: { select: { name: true } }, 
            alertEmail: true
        } 
    });

    if (!alertWithUser) return console.warn(`Alert ${id} not found.`);
    const userName = alertWithUser.user?.name || 'User';
    const recipientEmail = alertEmail; 
    
    // 2. Fetch Live AQI Data
    const aqiUrl = `http://api.openweathermap.org/data/2.5/air_pollution?lat=${CHECK_LAT}&lon=${CHECK_LON}&appid=${API_KEY}`;
    let aqiData;
    try {
        const response = await fetch(aqiUrl);
        if (!response.ok) throw new Error(`OpenWeather API fetch failed with status ${response.status}.`);
        aqiData = await response.json();
    } catch (e) {
        return console.error(`Failed to fetch AQI for recipient ${recipientEmail} (non-critical):`, e.message);
    }

    const currentAqiValue = aqiData.list[0].main.aqi; 
    
    let subject;
    let htmlContent;
    
    // 3. Check against threshold and set predefined messages
    if (currentAqiValue > threshold) {
        // AQI is HIGH
        console.log(`ALERT TRIGGERED for ${recipientEmail}! AQI: ${currentAqiValue} > Threshold: ${threshold}`);
        
        subject = `🔴 AQI Alert: High Pollution Detected!`;
        htmlContent = `
            <p>Hello ${userName},</p>
            <h3 style="color: #b91c1c;">The Air Quality Index (AQI) is high.</h3>
            <p>Current AQI: <span style="font-weight: bold; font-size: 1.1em;">${currentAqiValue}</span> (Threshold: ${threshold})</p>
            <p>We recommend you **do not go outdoors** or limit your outdoor activities significantly.</p>
            <p class="small">Alert time: ${alertTime} (Location: New Delhi).</p>
        `;
    } else {
        // AQI is SAFE
        console.log(`All Clear for ${recipientEmail}. Current AQI (${currentAqiValue}) is safe.`);
        
        subject = `🟢 AQI Alert: Safe to Go Outside!`;
        htmlContent = `
            <p>Hello ${userName},</p>
            <h3 style="color: #3b5d46;">Air quality is currently good or moderate.</h3>
            <p>Current AQI: <span style="font-weight: bold; font-size: 1.1em;">${currentAqiValue}</span> (Threshold: ${threshold})</p>
            <p>It is generally safe for you to **go outdoors** for your planned activity.</p>
            <p class="small">Alert time: ${alertTime} (Location: New Delhi).</p>
        `;
    }
    
    // 4. Send Email via Resend
    if (resend) {
         try {
            const { data, error } = await resend.emails.send({
                // CRITICAL: Ensure the sender email is verified in your Resend account.
                from: 'BreathWise Alerts <onboarding@resend.dev>', 
                to: recipientEmail,
                subject: subject,
                html: htmlContent,
            });
            if (error) {
                // LOG THE ERROR DETAILS FROM RESEND
                console.error('RESEND API FAILURE:', error);
                throw new Error(error.message);
            }
            console.log(`Email sent successfully to ${recipientEmail}. Resend ID: ${data.id}`);
        } catch (e) {
            console.error('Resend Email Error (Final):', e.message);
        }
    } else {
         console.log(`Email sending skipped for ${recipientEmail} due to missing RESEND_API_KEY.`);
    }
}

/** Initializes cron jobs for all alerts in the database. */
async function setupCronJobs() {
    cron.getTasks().forEach(task => task.stop());

    const alerts = await prisma.alert.findMany();
    
    alerts.forEach(alert => {
        const [hour, minute] = alert.alertTime.split(':');
        const cronSchedule = `${minute} ${hour} * * *`; 
        
        cron.schedule(cronSchedule, () => {
            checkAqiAndSendAlert(alert);
        }, {
            scheduled: true,
            timezone: "Asia/Kolkata" // FIX: Setting timezone to IST
        });
        console.log(`Scheduled alert for User ${alert.userId} (Recipient: ${alert.alertEmail}) at ${alert.alertTime} (IST).`);
    });
}

// --- AUTH MIDDLEWARE ---
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- AUTH ROUTES ---
app.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already exists.' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, password: hashed } });
    res.json({ message: 'User created successfully', user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Signup Error:', err);
    res.status(500).json({ error: 'Signup failed.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials.' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password.' });

    const token = jwt.sign({ userId: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, name: user.name });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Alerts API: Saves a new alert and restarts cron jobs
app.post('/alert', authMiddleware, async (req, res) => {
  try {
    const { alertTime, pollutant, threshold, alertEmail } = req.body; 
    
    if (!alertTime || !pollutant || !threshold || !alertEmail) {
         return res.status(400).json({ error: 'Missing required alert details (Time, Pollutant, Threshold, Email).' });
    }
    
    const alert = await prisma.alert.create({
      data: { 
          userId: req.user.userId, 
          alertTime, 
          pollutant, 
          threshold: parseFloat(threshold), 
          alertEmail: alertEmail 
      }
    });
    
    setupCronJobs();
    
    res.json({ message: 'Alert created successfully and scheduled.', alert });
  } catch (err) {
    console.error('Alert Error:', err);
    res.status(500).json({ error: 'Failed to create alert.' });
  }
});

app.post('/aqi/save', authMiddleware, async (req, res) => {
  try {
    const { location, pm25, pm10, aqiValue, rawPayload } = req.body;
    const record = await prisma.aQIReading.create({
      data: { location, pm25, pm10, aqiValue, rawPayload }
    });
    res.json({ message: 'AQI saved', record });
  } catch (err) {
    console.error('AQI Save Error:', err);
    res.status(500).json({ error: 'Failed to save AQI.' });
  }
});

app.post('/feedback', authMiddleware, async (req, res) => {
  try {
    const { message, rating } = req.body;
    const fb = await prisma.feedback.create({
      data: { userId: req.user.userId, message, rating }
    });
    res.json({ message: 'Feedback submitted', fb });
  } catch (err) {
    console.error('Feedback Error:', err);
    res.status(500).json({ error: 'Failed to submit feedback.' });
  }
});


app.get('/api/v1/aqi-data', async (req, res, next) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: "Missing 'lat' or 'lon' query parameters." });
  }

  try {
    // FIX: Using the client's lat/lon request for the dashboard data
    const aqiUrl = `http://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`;
    const weatherUrl = `http://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric`;

    const [aqiResponse, weatherResponse] = await Promise.all([
      fetch(aqiUrl),
      fetch(weatherUrl)
    ]);

    if (!aqiResponse.ok || !weatherResponse.ok) {
      const aqiError = !aqiResponse.ok ? await aqiResponse.text() : 'OK';
      const weatherError = !weatherResponse.ok ? await weatherResponse.text() : 'OK';
      console.error(`API Fetch Error. AQI Status: ${aqiResponse.status}, Weather Status: ${weatherResponse.status}`);
      console.error(`AQI Error: ${aqiError}, Weather Error: ${weatherError}`);
      return res.status(502).json({ error: "One or more OpenWeather API calls failed. See server logs for details." });
    }

    const aqiData = await aqiResponse.json();
    const weatherData = await weatherResponse.json();

    try {
      await prisma.aQIReading.create({
        data: {
          location: weatherData.name || 'Unknown',
          pm25: aqiData.list[0].components.pm2_5,
          pm10: aqiData.list[0].components.pm10,
          aqiValue: aqiData.list[0].main.aqi,
          rawPayload: JSON.stringify(aqiData) 
        }
      });
    } catch (dbErr) {
      console.error('Auto-save AQI to DB failed (non-critical):', dbErr);
    }

    const openWeatherAqiLevel = aqiData.list[0].main.aqi;
    let uiAqiLevelIndex = 1;
    let uiAqiLevel = 'Good';
    let uiAqiMessage = 'Air quality is excellent. Go out and enjoy the day!';
    let uiHealthImpact = 'Minimal Risk';
    switch (openWeatherAqiLevel) {
      case 2:
        uiAqiLevelIndex = 2;
        uiAqiLevel = 'Fair';
        uiAqiMessage = 'Air quality is acceptable.';
        uiHealthImpact = 'Low Risk';
        break;
      case 3:
        uiAqiLevelIndex = 3;
        uiAqiLevel = 'Moderate';
        uiAqiMessage = 'People with respiratory issues should limit outdoor activity.';
        uiHealthImpact = 'Medium Risk';
        break;
      case 4:
        uiAqiLevelIndex = 4;
        uiAqiLevel = 'Poor';
        uiAqiMessage = 'Health effects possible for everyone.';
        uiHealthImpact = 'High Risk';
        break;
      case 5:
        uiAqiLevelIndex = 5;
        uiAqiLevel = 'Very Poor';
        uiAqiMessage = 'Emergency conditions; stay indoors.';
        uiHealthImpact = 'Severe Risk';
        break;
    }

    const combinedData = {
      location: {
        name: weatherData.name || 'Unknown Location',
        lastUpdated: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
      },
      aqi: {
        value: openWeatherAqiLevel,
        levelIndex: uiAqiLevelIndex,
        level: uiAqiLevel,
        message: uiAqiMessage,
        healthImpact: uiHealthImpact
      },
      components: {
        pm25: Math.round(aqiData.list[0].components.pm2_5 * 10) / 10 || 0,
        pm10: Math.round(aqiData.list[0].components.pm10 * 10) / 10 || 0,
        no2: Math.round(aqiData.list[0].components.no2 * 10) / 10 || 0,
        o3: Math.round(aqiData.list[0].components.o3 * 10) / 10 || 0,
        so2: Math.round(aqiData.list[0].components.so2 * 10) / 10 || 0
      },
      weather: {
        temp: Math.round(weatherData.main.temp),
        description: weatherData.weather[0].description,
        humidity: weatherData.main.humidity,
        windSpeed: Math.round(weatherData.wind.speed * 3.6)
      }
    };
    res.json(combinedData);
  } catch (err) {
    next(err);
  }
});


app.get('/', async (req, res, next) => {
  const indexFileName = 'index.html';
  const indexPath = path.join(PUBLIC_DIR, indexFileName);
  try {
    await fs.access(indexPath, constants.F_OK);
    // Since static middleware is added, this manual route can be simplified/removed, 
    // but leaving it to ensure index.html loads at the root.
    return res.sendFile(indexPath, { maxAge: 0 });
  } catch (err) {
    if (err.code !== 'ENOENT') return next(err);
  }

  try {
    const entries = await fs.readdir(PUBLIC_DIR, { withFileTypes: true });
    const htmlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.html')).map(e => e.name).sort();
    if (htmlFiles.length === 0) return res.status(404).send('No HTML files found.');
    return res.sendFile(path.join(PUBLIC_DIR, htmlFiles[0]), { maxAge: 0 });
  } catch (err) {
    next(err);
  }
});

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
  console.error('General Server Error:', err.stack || err);
  res.status(500).send('Server error');
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    setupCronJobs();
});