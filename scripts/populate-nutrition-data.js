#!/usr/bin/env node

/**
 * Populate nutrition data for the past 90 days
 * This is a temporary script to generate mock nutrition data
 * Usage: node populate-nutrition-data.js <email> <password> <clientId>
 */

let cookieJar = {};

// Food database with macros (per standard serving)
const FOODS = {
  breakfast: [
    { name: '4 Eggs', calories: 286, protein: 24, carbs: 3, fat: 22, qty: '4' },
    { name: '6 Eggs', calories: 429, protein: 36, carbs: 4.5, fat: 33, qty: '6' },
    { name: '2 Slices Bread with Mayo', calories: 320, protein: 8, carbs: 35, fat: 16, qty: '2' },
    { name: '1 Slice Bread with Mayo', calories: 160, protein: 4, carbs: 17.5, fat: 8, qty: '1' },
    { name: '3 Slices Turkey Ham', calories: 105, protein: 18, carbs: 0, fat: 3, qty: '3' },
    { name: '1 Cup Oatmeal', calories: 300, protein: 10, carbs: 54, fat: 6, qty: '1 cup' },
    { name: '3 Pancakes/Waffles', calories: 450, protein: 9, carbs: 60, fat: 18, qty: '3' },
    { name: 'Coffee with Milk & Sugar', calories: 80, protein: 3, carbs: 12, fat: 2, qty: '1 cup' }
  ],
  lunch: [
    { name: '50g Rice + 200g Chicken Breast', calories: 380, protein: 58, carbs: 35, fat: 4, qty: '50g+200g' },
    { name: '80g Rice + 200g Chicken Breast', calories: 460, protein: 58, carbs: 48, fat: 4, qty: '80g+200g' },
    { name: '50g Rice + 100g Minced Turkey', calories: 310, protein: 35, carbs: 35, fat: 5, qty: '50g+100g' },
    { name: '80g Rice + 200g Minced Turkey', calories: 460, protein: 52, carbs: 48, fat: 9, qty: '80g+200g' },
    { name: '1 Cordon Bleu', calories: 520, protein: 42, carbs: 25, fat: 26, qty: '1' },
    { name: '100g Teriyaki Chicken Strips', calories: 280, protein: 35, carbs: 18, fat: 6, qty: '100g' },
    { name: '200g Teriyaki Chicken Strips', calories: 560, protein: 70, carbs: 36, fat: 12, qty: '200g' }
  ],
  dinner: [
    { name: '50g Rice + 200g Chicken Breast', calories: 380, protein: 58, carbs: 35, fat: 4, qty: '50g+200g' },
    { name: '80g Rice + 200g Chicken Breast', calories: 460, protein: 58, carbs: 48, fat: 4, qty: '80g+200g' },
    { name: '50g Rice + 100g Minced Turkey', calories: 310, protein: 35, carbs: 35, fat: 5, qty: '50g+100g' },
    { name: '80g Rice + 200g Minced Turkey', calories: 460, protein: 52, carbs: 48, fat: 9, qty: '80g+200g' },
    { name: '1 Cordon Bleu', calories: 520, protein: 42, carbs: 25, fat: 26, qty: '1' },
    { name: '100g Teriyaki Chicken Strips', calories: 280, protein: 35, carbs: 18, fat: 6, qty: '100g' },
    { name: '200g Teriyaki Chicken Strips', calories: 560, protein: 70, carbs: 36, fat: 12, qty: '200g' }
  ],
  snacks: [
    { name: 'Protein Bar', calories: 220, protein: 20, carbs: 22, fat: 7, qty: '1 bar' },
    { name: 'Greek Yogurt with Granola & Honey', calories: 280, protein: 20, carbs: 35, fat: 5, qty: '1 cup' },
    { name: 'Salmon Slice', calories: 280, protein: 34, carbs: 0, fat: 15, qty: '1 slice' },
    { name: 'Black Coffee', calories: 0, protein: 0, carbs: 0, fat: 0, qty: '1 cup' },
    { name: 'Pita Chips/Veggie Sticks', calories: 150, protein: 3, carbs: 18, fat: 7, qty: '1 cup' },
    { name: 'Export Soda Crackers with Almond Butter', calories: 320, protein: 12, carbs: 28, fat: 18, qty: 'w/ 2-3 tbsp' }
  ]
};

function getRandomItem(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateRandomMeals() {
  const meals = {};

  // Breakfast (always)
  const breakfast = getRandomItem(FOODS.breakfast);
  meals['desayuno'] = {
    foods: [{
      name: breakfast.name,
      calories: breakfast.calories,
      protein: breakfast.protein,
      carbs: breakfast.carbs,
      fat: breakfast.fat,
      serving: breakfast.qty,
      servingUnit: 'serving'
    }]
  };

  // Lunch (always)
  const lunch = getRandomItem(FOODS.lunch);
  meals['almuerzo'] = {
    foods: [{
      name: lunch.name,
      calories: lunch.calories,
      protein: lunch.protein,
      carbs: lunch.carbs,
      fat: lunch.fat,
      serving: lunch.qty,
      servingUnit: 'serving'
    }]
  };

  // Dinner (always, but different from lunch)
  let dinner = getRandomItem(FOODS.dinner);
  while (dinner.name === lunch.name && FOODS.dinner.length > 1) {
    dinner = getRandomItem(FOODS.dinner);
  }
  meals['cena'] = {
    foods: [{
      name: dinner.name,
      calories: dinner.calories,
      protein: dinner.protein,
      carbs: dinner.carbs,
      fat: dinner.fat,
      serving: dinner.qty,
      servingUnit: 'serving'
    }]
  };

  // Snacks (30% chance to have one)
  if (Math.random() < 0.7) {
    const snack = getRandomItem(FOODS.snacks);
    meals['snack'] = {
      foods: [{
        name: snack.name,
        calories: snack.calories,
        protein: snack.protein,
        carbs: snack.carbs,
        fat: snack.fat,
        serving: snack.qty,
        servingUnit: 'serving'
      }]
    };
  }

  return meals;
}

function calculateTotals(meals) {
  let totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

  Object.values(meals).forEach(meal => {
    meal.foods.forEach(food => {
      totals.calories += food.calories || 0;
      totals.protein += food.protein || 0;
      totals.carbs += food.carbs || 0;
      totals.fat += food.fat || 0;
    });
  });

  return totals;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function login(email, password) {
  try {
    const response = await fetch('http://localhost:3010/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      console.error('Login failed:', response.statusText);
      return false;
    }

    // Extract and store Set-Cookie header
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/auth_token=([^;]+)/);
      if (match) {
        cookieJar.auth_token = match[1];
        console.log('✓ Logged in successfully');
        return true;
      }
    }

    console.error('No auth cookie received');
    return false;
  } catch (error) {
    console.error('Login error:', error.message);
    return false;
  }
}

async function postNutritionData(clientId, date, meals, totals) {
  const payload = {
    clientId,
    date,
    calories: Math.round(totals.calories),
    protein: Math.round(totals.protein * 10) / 10,
    carbs: Math.round(totals.carbs * 10) / 10,
    fat: Math.round(totals.fat * 10) / 10,
    water: getRandomInt(60, 100), // Random water intake in oz
    meals,
    notes: ''
  };

  try {
    const headers = {
      'Content-Type': 'application/json'
    };

    // Add cookie if available
    if (cookieJar.auth_token) {
      headers['Cookie'] = `auth_token=${cookieJar.auth_token}`;
    }

    const response = await fetch('http://localhost:3010/api/nutrition-logs', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`Failed to post nutrition for ${date}:`, response.statusText);
      return false;
    }

    console.log(`✓ ${date} - ${Math.round(totals.calories)} cal (P: ${Math.round(totals.protein)}g, C: ${Math.round(totals.carbs)}g, F: ${Math.round(totals.fat)}g)`);
    return true;
  } catch (error) {
    console.error(`Error posting nutrition for ${date}:`, error.message);
    return false;
  }
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const clientId = process.argv[4];

  if (!email || !password || !clientId) {
    console.error('Usage: node populate-nutrition-data.js <email> <password> <clientId>');
    console.error('Example: node populate-nutrition-data.js suarez_a_92@hotmail.com "92_a_Zeraus" 507f1f77bcf86cd799439011');
    process.exit(1);
  }

  console.log('🔐 Logging in...');
  const loggedIn = await login(email, password);
  if (!loggedIn) {
    console.error('Failed to authenticate');
    process.exit(1);
  }

  console.log(`\n📅 Generating 90 days of nutrition data for client: ${clientId}`);
  console.log('Starting from 90 days ago until yesterday...\n');

  // Calculate date range: 90 days ago to yesterday
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 90);

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() - 1);

  console.log(`Date range: ${formatDate(startDate)} to ${formatDate(endDate)}\n`);

  let successCount = 0;
  let failCount = 0;

  // Generate data for each day
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const meals = generateRandomMeals();
    const totals = calculateTotals(meals);
    const dateStr = formatDate(currentDate);

    const success = await postNutritionData(clientId, dateStr, meals, totals);

    if (success) {
      successCount++;
    } else {
      failCount++;
    }

    currentDate.setDate(currentDate.getDate() + 1);

    // Small delay to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log(`\n✓ Completed! Success: ${successCount}, Failed: ${failCount}`);
  console.log(`Total entries created: ${successCount}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
