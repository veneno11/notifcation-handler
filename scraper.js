const axios = require('axios');
const admin = require('firebase-admin');

// 1. Initialize Firebase Securely
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

async function runScraper() {
  try {
    console.log("Authenticating with PlusPortals...");
    
    // Note: PlusPortals usually requires your specific school name in the URL 
    // e.g., https://www.plusportals.com/YourSchoolName/api/login
    // Update this URL if your network capture showed a different login endpoint.
    const loginUrl = 'https://www.plusportals.com/api/login'; 
    
    const loginResponse = await axios.post(loginUrl, {
      UserName: process.env.PLUSPORTALS_USER,
      Password: process.env.PLUSPORTALS_PASS
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies) throw new Error("Authentication failed: No session cookies returned.");
    
    // Format cookies for the next request
    const sessionCookies = cookies.map(cookie => cookie.split(';')[0]).join('; ');

    console.log("Fetching grade summaries...");
    // 2. Fetch the grades using the captured session
    const gradesResponse = await axios.get('https://www.plusportals.com/ParentStudentDetails/GetScoresSummaryView', {
      headers: { 
        'Cookie': sessionCookies 
      }
    });

    console.log("Pushing data to Firebase...");
    // 3. Store the data in your Firestore database
    // We use your email prefix as the userId to match the security rules
    const userId = process.env.PLUSPORTALS_USER.split('@')[0]; 
    
    await db.collection('users').doc(userId).collection('grades').doc('current').set({
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      summary: gradesResponse.data
    });

    console.log("Successfully updated dashboard data.");

  } catch (error) {
    console.error("Extraction Error:", error.message);
    process.exit(1); // Fails the GitHub Action so you are notified of errors
  }
}

runScraper();
