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

    // First, check in UTS Startups table (primary contact email)
    console.log('🔍 Checking startups table first...');
    let startups = await base('UTS Startups').select({
      filterByFormula: `{Primary contact email} = "${email}"`
    }).firstPage();

    let startupName;
    let startup;

    if (startups.length > 0) {
      // Found in startups table
      startup = startups[0];
      startupName = startup.get('Startup Name (or working title)');
      console.log(`✅ Found email in startups table - Startup: ${startupName}`);
    } else {
      // If not in startups table, check team members table
      console.log('🔍 Not in startups table, checking team members...');
      const teamMembers = await base('Team members').select({
        filterByFormula: `{Personal email*} = "${email}"`
      }).firstPage();

      if (teamMembers.length === 0) {
        console.log('❌ Email not found in either startups or team members');
        return res.status(404).json({ error: 'Email not found in our records' });
      }

      console.log(`✅ Found email in team members table`);
      const teamMember = teamMembers[0];
      startupName = teamMember.get('Startup*');

      if (!startupName) {
        console.log('❌ No startup associated with this team member email');
        return res.status(404).json({ error: 'No startup associated with this email' });
      }

      // Find the startup record
      console.log(`🔍 Searching for startup: ${startupName}`);
      startups = await base('UTS Startups').select({
        filterByFormula: `{Startup Name (or working title)} = "${startupName}"`
      }).firstPage();

      if (startups.length === 0) {
        console.log(`❌ Startup "${startupName}" not found`);
        return res.status(404).json({ error: 'Startup not found' });
      }

      startup = startups[0];
      console.log('✅ Found startup record');
    }

        // Generate unique token (expires in 15 minutes)
    const token = jwt.sign(
      { 
        startupId: startup.id,
        startupName: startupName,
        email: email,
        timestamp: Date.now()
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    // Create magic link
    const magicLink = `${req.protocol}://${req.get('host')}/dashboard/${token}`;
    
    // Calculate expiry date (15 minutes from now)
    const expiryDate = new Date();
    expiryDate.setMinutes(expiryDate.getMinutes() + 15);

    // Update the startup record with magic link
    console.log('💾 Saving magic link to Airtable...');
    await base('UTS Startups').update(startup.id, {
      'Magic Link': magicLink,
      'Token Expires At': expiryDate.toISOString(), // Full ISO format with time
      'Link': magicLink
    });
    console.log('✅ Magic link saved to Airtable');

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
                <h2>Update Team Member Profiles</h2>
                <p class="subtitle">Each team member can update their individual profile</p>
                ${data.teamMembers.map((member, index) => `
                    <div class="member-profile-section" data-member-id="${member.id}">
                        <h3 class="profile-member-name">
                            <span class="member-avatar-small">${member.name ? member.name.charAt(0).toUpperCase() : 'M'}</span>
                            ${member.name}
                        </h3>
                        <form id="profileForm${index}" class="profile-form" data-member-id="${member.id}">
                            <div class="form-grid">
                                <div class="form-group">
                                    <label for="personalEmail${index}">Personal Email</label>
                                    <input type="email" id="personalEmail${index}" name="Personal email*" value="${member.email || ''}" required>
                                </div>
                                <div class="form-group">
                                    <label for="mobile${index}">Mobile Number</label>
                                    <input type="tel" id="mobile${index}" name="Mobile*" value="${member.mobile || ''}" required>
                                </div>
                                <div class="form-group full-width">
                                    <label for="position${index}">Position at Startup</label>
                                    <input type="text" id="position${index}" name="Position at startup*" value="${member.position || ''}" required>
                                </div>
                                <div class="form-group full-width">
                                    <label for="utsAssociation${index}">What is your association to UTS?</label>
                                    <input type="text" id="utsAssociation${index}" name="What is your association to UTS?*" value="${member.utsAssociation || ''}" required>
                                </div>
                            </div>
                            <button type="submit" class="submit-btn">Update ${member.name}'s Profile</button>
                        </form>
                    </div>
                    ${index < data.teamMembers.length - 1 ? '<div class="profile-divider"></div>' : ''}
                `).join('')}
            </div>
        </div>
    </div>

    <script>
        const token = '${data.token}';
        const teamMembers = ${JSON.stringify(data.teamMembers)};

        // Handle form submissions for each team member
        document.addEventListener('DOMContentLoaded', function() {
            teamMembers.forEach((member, index) => {
                const form = document.getElementById('profileForm' + index);
                if (form) {
                    form.addEventListener('submit', async function(e) {
                        e.preventDefault();
                        
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
                                    memberId: member.id,
                                    updates: updates
                                })
                            });

                            const result = await response.json();

                            if (result.success) {
                                Swal.fire('Success!', \`\${member.name}'s profile has been updated.\`, 'success');
                            } else {
                                Swal.fire('Error', result.error || 'Failed to update profile', 'error');
                            }
                        } catch (error) {
                            console.error('Error:', error);
                            Swal.fire('Error', 'Failed to update profile', 'error');
                        }
                    });
                }
            });
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