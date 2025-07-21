const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Airtable = require('airtable');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Configure Airtable
const base = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY
}).base(process.env.AIRTABLE_BASE_ID);

// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Email lookup endpoint
app.post('/lookup-email', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    console.log(`🔍 Searching for email: ${email}`);

    // Search in Team members table using the correct field name
    const teamMembers = await base('Team members').select({
      filterByFormula: `{Personal email*} = "${email}"`
    }).firstPage();

    if (teamMembers.length === 0) {
      console.log('❌ Email not found in our records');
      return res.status(404).json({ error: 'Email not found in our records' });
    }

    console.log(`✅ Found team member record`)

    const teamMember = teamMembers[0];
    const startupName = teamMember.get('Startup*');
    console.log(`🏢 Startup name: ${startupName}`);

    if (!startupName) {
      console.log('❌ No startup associated with this email');
      return res.status(404).json({ error: 'No startup associated with this email' });
    }

    // Find the startup record
    console.log('🔍 Searching for startup record...');
    const startups = await base('UTS Startups').select({
      filterByFormula: `{Startup Name (or working title)} = "${startupName}"`
    }).firstPage();

    if (startups.length === 0) {
      console.log(`❌ Startup "${startupName}" not found`);
      return res.status(404).json({ error: 'Startup not found' });
    }
    
    console.log('✅ Found startup record');

    const startup = startups[0];

    // Generate unique token
    const token = jwt.sign(
      {
        startupId: startup.id,
        startupName: startupName,
        email: email,
        timestamp: Date.now()
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Create magic link
    const magicLink = `${req.protocol}://${req.get('host')}/dashboard/${token}`;

    // Calculate expiry date (7 days from now)
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7);

    // Update the startup record with magic link
    await base('UTS Startups').update(startup.id, {
      'Magic Link': magicLink,
      'Token Expires At': expiryDate.toISOString().split('T')[0], // YYYY-MM-DD format
      'Link': magicLink
    });

    res.json({
      success: true,
      message: 'Magic link generated successfully!',
      redirectUrl: magicLink
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Dashboard route
app.get('/dashboard/:token', async (req, res) => {
  const { token } = req.params;

  try {
    // Verify and decode token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get startup data
    const startup = await base('UTS Startups').find(decoded.startupId);

    // Get all team members for this startup
    const teamMembers = await base('Team members').select({
      filterByFormula: `{Startup*} = "${decoded.startupName}"`
    }).firstPage();

    // Prepare data for template
    const dashboardData = {
      startup: {
        id: startup.id,
        name: startup.get('Startup Name (or working title)'),
        primaryContact: startup.get('Primary contact email'),
        recordId: startup.get('Record ID'),
        status: startup.get('Startup status')
      },
      teamMembers: teamMembers.map(member => ({
        id: member.id,
        name: member.get('Team member ID'),
        email: member.get('Personal email*'),
        mobile: member.get('Mobile*'),
        position: member.get('Position at startup*'),
        utsAssociation: member.get('What is your association to UTS?*'),
        status: member.get('Team Member Status')
      })),
      token: token
    };

    // Send dashboard HTML
    res.send(generateDashboardHTML(dashboardData));

  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).send(`
      <html>
        <head><title>Invalid Link</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h2>Invalid or Expired Link</h2>
          <p>This link is invalid or has expired. Please request a new one.</p>
          <a href="/" style="color: #007bff; text-decoration: none;">← Go back to home</a>
        </body>
      </html>
    `);
  }
});

// Update team member profile
app.post('/update-profile', async (req, res) => {
  const { token, memberId, updates } = req.body;

  try {
    // Verify token
    jwt.verify(token, process.env.JWT_SECRET);

    // Update the team member record
    await base('Team members').update(memberId, updates);

    res.json({ success: true, message: 'Profile updated successfully!' });

  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Generate Dashboard HTML
function generateDashboardHTML(data) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.startup.name} - Dashboard</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
</head>
<body>
    <div class="container">
        <header class="header">
            <div class="header-content">
                <div class="logo">
                    <div class="logo-icon">📋</div>
                    <h1>${data.startup.name}</h1>
                </div>
                <button class="update-profile-btn" onclick="showUpdateModal()">
                    ✏️ Update Profile
                </button>
            </div>
            <p class="subtitle">Startup Dashboard</p>
        </header>

        <div class="dashboard-grid">
            <div class="card">
                <h2>📊 Startup Information</h2>
                <div class="info-grid">
                    <div class="info-item">
                        <span class="label">Startup Name</span>
                        <span class="value">${data.startup.name}</span>
                    </div>
                    <div class="info-item">
                        <span class="label">Primary Contact</span>
                        <span class="value">${data.startup.primaryContact}</span>
                    </div>
                    <div class="info-item">
                        <span class="label">Team Size</span>
                        <span class="value">${data.teamMembers.length} members</span>
                    </div>
                </div>
            </div>

            <div class="card">
                <h2>👥 Team Members</h2>
                <p class="subtitle">All members of your startup team</p>
                <div class="team-list">
                    ${data.teamMembers.map(member => `
                        <div class="team-member" data-member-id="${member.id}">
                            <div class="member-avatar">S</div>
                            <div class="member-info">
                                <div class="member-name">${member.name}</div>
                                <div class="member-details">
                                    <span class="member-role">📋 ${member.position}</span>
                                    <span class="member-contact">📞 ${member.mobile || 'N/A'}</span>
                                    <span class="member-email">📧 ${member.utsAssociation}</span>
                                </div>
                            </div>
                            <span class="member-status ${member.status ? member.status.toLowerCase() : 'active'}">${member.status || 'Active'}</span>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="card profile-card">
                <h2>Your Profile</h2>
                <p class="subtitle">Update your contact details and position information</p>
                <form id="profileForm" class="profile-form">
                    <div class="form-grid">
                        <div class="form-group">
                            <label for="personalEmail">Personal Email</label>
                            <input type="email" id="personalEmail" name="Personal email*" required>
                        </div>
                        <div class="form-group">
                            <label for="mobile">Mobile Number</label>
                            <input type="tel" id="mobile" name="Mobile*" required>
                        </div>
                        <div class="form-group full-width">
                            <label for="position">Position at Startup</label>
                            <input type="text" id="position" name="Position at startup*" required>
                        </div>
                        <div class="form-group full-width">
                            <label for="utsAssociation">What is your association to UTS?</label>
                            <input type="text" id="utsAssociation" name="What is your association to UTS?*" required>
                        </div>
                    </div>
                    <button type="submit" class="submit-btn">Update Information</button>
                </form>
            </div>
        </div>
    </div>

    <script>
        const token = '${data.token}';
        let currentMemberId = null;

        // Load current user data (first team member for now)
        document.addEventListener('DOMContentLoaded', function() {
            const teamMembers = ${JSON.stringify(data.teamMembers)};
            if (teamMembers.length > 0) {
                const currentUser = teamMembers[0]; // In real app, identify current user
                currentMemberId = currentUser.id;
                document.getElementById('personalEmail').value = currentUser.email || '';
                document.getElementById('mobile').value = currentUser.mobile || '';
                document.getElementById('position').value = currentUser.position || '';
                document.getElementById('utsAssociation').value = currentUser.utsAssociation || '';
            }
        });

        // Handle form submission
        document.getElementById('profileForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            if (!currentMemberId) {
                Swal.fire('Error', 'Unable to identify your profile', 'error');
                return;
            }

            const formData = new FormData(this);
            const updates = {};
            
            for (let [key, value] of formData.entries()) {
                updates[key] = value;
            }

            try {
                const response = await fetch('/update-profile', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        token: token,
                        memberId: currentMemberId,
                        updates: updates
                    })
                });

                const result = await response.json();

                if (result.success) {
                    Swal.fire('Success!', 'Your profile has been updated.', 'success');
                } else {
                    Swal.fire('Error', result.error || 'Failed to update profile', 'error');
                }
            } catch (error) {
                console.error('Error:', error);
                Swal.fire('Error', 'Failed to update profile', 'error');
            }
        });

        function showUpdateModal() {
            document.querySelector('.profile-card').scrollIntoView({ behavior: 'smooth' });
        }
    </script>
</body>
</html>
  `;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the application at http://localhost:${PORT}`);
}); 