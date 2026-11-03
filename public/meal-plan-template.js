/* ══════════════════════════════════════════════════════════════════════════
   MEAL PREP — the 8-week progressive template
   ──────────────────────────────────────────────────────────────────────────
   A starting point, not a fixed plan. "Usar plantilla" in the Meal Prep editor
   loads this into the form; every line is editable from there before saving,
   and editing it afterwards never touches this file.

   Two preps per week (A and B) hitting the same daily numbers, so a week can be
   cooked in two batches — three or four days of each — instead of eating the
   same plate seven nights running. Protein holds at ~125 g the whole way down;
   the deficit comes out of carbs and fat.

   This file is data only. It is kept out of app.js because it is prose, not
   logic, and prose this long buried in a 17k-line file is prose nobody finds.
   ══════════════════════════════════════════════════════════════════════════ */

(function () {
    // Shorthand so a week reads as a table instead of eighty lines of braces:
    // every meal is [slot, text], and alternatives are added in the editor.
    const prep = (key, label, meals) => ({
        key,
        label,
        meals: meals.map(([slot, text]) => ({ slot, text, alternatives: [] })),
    });

    window.MEAL_PLAN_TEMPLATE = {
        name: 'Déficit progresivo — 8 semanas',
        description: 'Baja de mantenimiento a −500 kcal en ocho semanas. Dos preparaciones por semana con los mismos macros, para alternar sin comer lo mismo todos los días.',
        weeks: [
            {
                week: 1,
                objective: 'Establecer una base estable, ver cómo responde el metabolismo y armar la rutina de meal prep sin restricción.',
                calories: 1700, protein: 125, carbs: 180, fat: 50, deficit: 0,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', 'Avena (3/4 taza en seco) cocida en leche de almendras, 1 scoop de whey, 1 cda de chía y 1/2 taza de arándanos.'],
                        ['Almuerzo', 'Pechuga de pollo a la parrilla (5 oz), 1 taza de quinoa cocida, mezcla de hojas verdes, pepinillo y 1 cda de vinagreta de aceite de oliva.'],
                        ['Merienda', 'Yogur griego natural sin grasa (1 taza) con un puñito de nueces y canela.'],
                        ['Cena', 'Salmón al horno (5 oz) con batata asada (5 oz) y espárragos al vapor.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', '3 huevos revueltos con espinaca y tomate, 2 rebanadas de pan integral y 1/4 de aguacate.'],
                        ['Almuerzo', 'Pavo molido magro (5 oz) salteado con pimientos y cebolla sobre 1 taza de arroz integral cocido.'],
                        ['Merienda', 'Queso cottage (1 taza) con piña o berries en trozos.'],
                        ['Cena', 'Churrasco magro a la parrilla (5 oz) con papas al horno en gajos (5 oz) y habichuelas tiernas asadas.'],
                    ]),
                ],
            },
            {
                week: 2,
                objective: 'Bajar un poco recortando aceites añadidos y grasas de relleno, manteniendo la energía alta.',
                calories: 1630, protein: 125, carbs: 170, fat: 47, deficit: 70,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', '3 claras + 1 huevo entero revueltos con espinaca y tomate, más 1 rebanada de pan integral.'],
                        ['Almuerzo', 'Albóndigas de pavo magro (4.5 oz) con calabacín y pimientos asados y 3/4 taza de arroz integral.'],
                        ['Merienda', 'Manzana en rodajas con 1 cda de mantequilla de maní natural.'],
                        ['Cena', 'Churrasco magro (4.5 oz) con ensalada verde grande y 1/2 taza de papitas nuevas asadas.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Batida de proteína (1 scoop de whey, 1/2 guineo, 1/2 taza de avena, leche de almendras y 1 cda de mantequilla de almendras).'],
                        ['Almuerzo', 'Pechuga de pollo desmenuzada (4.5 oz) cocida en salsa, sobre 3/4 taza de habichuelas negras y 1/2 taza de arroz jazmín.'],
                        ['Merienda', 'Edamame (1 taza en vaina) con sal marina y un palito de queso.'],
                        ['Cena', 'Mahi-mahi o pescado blanco al horno (5.5 oz) con un toque de aceite de oliva, 1/2 taza de quinoa y espinaca salteada.'],
                    ]),
                ],
            },
            {
                week: 3,
                objective: 'Mantener la proteína alta para proteger la masa magra, cambiando carbohidratos densos por vegetales con fibra.',
                calories: 1560, protein: 125, carbs: 155, fat: 44, deficit: 140,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', 'Batida de proteína (1 scoop de whey, 1 taza de espinaca, 1/2 taza de berries congelados, agua y 1 cda de linaza).'],
                        ['Almuerzo', 'Pechuga de pollo a la parrilla (4.5 oz) en wrap bajo en carbohidratos con hojas verdes, tomate y aderezo liviano.'],
                        ['Merienda', 'Queso cottage (3/4 taza) con pepinillo en rodajas y pimienta negra.'],
                        ['Cena', 'Bacalao o tilapia al horno (5.5 oz) con coliflor asada y 1/2 taza de arroz salvaje.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Muffins de frittata (3 claras + 1 huevo entero, espinaca y tocineta de pavo en cubos) con 1/2 taza de melón.'],
                        ['Almuerzo', 'Lomillo de cerdo magro (4.5 oz) con coles de Bruselas asadas y 1/2 taza de majado de batata.'],
                        ['Merienda', '2 huevos hervidos con sazón everything bagel.'],
                        ['Cena', 'Wraps de lechuga con pollo molido (4.5 oz), glaseado de hoisin y soya, castañas de agua y edamame al lado.'],
                    ]),
                ],
            },
            {
                week: 4,
                objective: 'Asentar el punto medio del déficit y concentrar los carbohidratos alrededor del entrenamiento.',
                calories: 1490, protein: 125, carbs: 140, fat: 42, deficit: 210,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', '1 taza de claras + 1 huevo entero revueltos con hongos y pimientos, con 1/2 taza de berries.'],
                        ['Almuerzo', 'Ensalada de lentejas y habichuelas blancas con tomate, cebolla roja y limón, más pechuga de pollo a la parrilla (4 oz).'],
                        ['Merienda', 'Yogur griego natural sin grasa (3/4 taza) con 1 cda de chía y canela.'],
                        ['Cena', 'Salteado de pavo molido magro (4.5 oz) con brócoli, guisantes y jengibre sobre 1/3 taza de arroz integral.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', '1/2 taza de avena cocida en agua con 1 scoop de whey y 1 cda de cocoa, con 1/4 taza de frambuesas.'],
                        ['Almuerzo', 'Pinchos de camarón a la parrilla (5 oz) sobre ensalada tibia de quinoa (1/3 taza de quinoa, pepinillo, perejil y limón).'],
                        ['Merienda', 'Pimientos en tiras con 3 cdas de hummus.'],
                        ['Cena', 'Flank steak a la parrilla (4 oz) con habichuelas tiernas salteadas en ajo y 4 oz de calabaza butternut asada.'],
                    ]),
                ],
            },
            {
                week: 5,
                objective: 'Maximizar el volumen de comida con hojas verdes, crucíferas y proteínas que llenan.',
                calories: 1420, protein: 125, carbs: 130, fat: 38, deficit: 280,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', 'Claras revueltas (1 taza) con 1 huevo entero, espinaca y 1/4 de aguacate sobre 1 rebanada de pan integral.'],
                        ['Almuerzo', 'Pechuga de pollo desmenuzada (4 oz) sobre hojas verdes, tomatitos y pepinillo, con 1/3 taza de quinoa y aderezo de limón y hierbas.'],
                        ['Merienda', 'Yogur griego sin grasa (3/4 taza) con fresas en rodajas.'],
                        ['Cena', 'Pechuga de pollo asada con hierbas (4 oz) sobre kale salteado, con calabaza butternut asada (3 oz).'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Pudín de chía con proteína (1 scoop, 2 cdas de chía y leche de almendras sin azúcar, reposado de un día para otro).'],
                        ['Almuerzo', 'Atún sellado o atún en lata (4.5 oz) sobre espinaca, pepinillo y rábano, con 1/3 taza de arroz integral y aderezo liviano de soya y ajonjolí.'],
                        ['Merienda', 'Apio con 1.5 cdas de mantequilla de maní natural.'],
                        ['Cena', 'Chili de carne molida magra (93/7, 4 oz) con tomate triturado, 1/4 taza de habichuelas rojas y calabacín en cubos.'],
                    ]),
                ],
            },
            {
                week: 6,
                objective: 'Sostener el rendimiento en el gym con un margen ajustado. Prioriza la hidratación y los electrolitos.',
                calories: 1350, protein: 125, carbs: 115, fat: 35, deficit: 350,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', '1/2 taza de avena cocida en agua con 1 scoop de whey y canela.'],
                        ['Almuerzo', 'Salmón al horno (4 oz) con calabacín asado y 1/2 taza de arroz integral.'],
                        ['Merienda', 'Batida de proteína (1 scoop con agua y hielo) y pepinillo en rodajas.'],
                        ['Cena', 'Lomillo de cerdo magro (4 oz) con coles de Bruselas asadas y ensalada grande.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Tortilla (4 claras + 1 huevo entero) con espinaca, tomate en cubos y 1 oz de queso feta liviano.'],
                        ['Almuerzo', 'Hamburguesa de pavo a la parrilla (4.5 oz, sin pan) sobre arúgula con cebolla a la parrilla y 3 oz de batata asada.'],
                        ['Merienda', 'Queso cottage bajo en grasa (1/2 taza) con pimienta negra y tomatitos.'],
                        ['Cena', 'Pescado blanco al horno (bacalao o lenguado, 5 oz) con limón, brócoli al vapor y majado de coliflor.'],
                    ]),
                ],
            },
            {
                week: 7,
                objective: 'Preparar el cuerpo para la semana final con proteínas magras y fáciles de digerir.',
                calories: 1280, protein: 125, carbs: 100, fat: 33, deficit: 420,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', 'Tortilla de 2 huevos enteros con espinaca y hongos, con media toronja al lado.'],
                        ['Almuerzo', 'Pechuga de pollo a la parrilla (4 oz) sobre una cama grande de hojas verdes, pepinillo y pimientos, con aderezo de vinagre o limón.'],
                        ['Merienda', 'Queso cottage (1/2 taza) con tomate en rodajas y pimienta negra.'],
                        ['Cena', 'Pescado blanco o halibut (4.5 oz) con espárragos al vapor y 1/2 taza de majado de coliflor.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Bowl de proteína: yogur griego sin grasa (3/4 taza), 1/2 scoop de whey, 1 cda de linaza y 1/4 taza de arándanos.'],
                        ['Almuerzo', 'Pechuga de pavo en lascas (4.5 oz) enrolladas con mostaza, con ensalada grande de repollo y pepinillo y 1/3 taza de quinoa cocida.'],
                        ['Merienda', '1 huevo hervido y 10 almendras.'],
                        ['Cena', 'Tiernitos de pollo a la parrilla (4.5 oz) con hierbas, calabacín a la parrilla y pimientos asados.'],
                    ]),
                ],
            },
            {
                week: 8,
                objective: 'Ejecutar el déficit objetivo. Volumen con vegetales de alta agua y fibra, y los cortes de proteína más magros.',
                calories: 1200, protein: 125, carbs: 85, fat: 30, deficit: 500,
                options: [
                    prep('A', 'Prep A', [
                        ['Desayuno', 'Claras revueltas (1 taza) con 1 huevo entero, espinaca y hongos, con 1/4 de aguacate.'],
                        ['Almuerzo', 'Pechuga de pavo magra (4 oz) con ensalada verde grande (romana, pepinillo y rábano) y aderezo liviano de limón.'],
                        ['Merienda', 'Yogur griego natural sin grasa (3/4 taza) con canela y 1/4 taza de arándanos.'],
                        ['Cena', 'Pescado blanco o camarones a la parrilla (5 oz) con brócoli al vapor y fideos de calabacín en buena cantidad.'],
                    ]),
                    prep('B', 'Prep B', [
                        ['Desayuno', 'Panqueque de claras (1 taza de claras, 2 cdas de harina de coco, canela y stevia, a fuego bajo) con 1/4 taza de fresas frescas.'],
                        ['Almuerzo', 'Pechuga de pollo a la parrilla (4 oz) en lascas sobre habichuelas tiernas y hongos salteados con 1/4 taza de habichuelas negras.'],
                        ['Merienda', 'Batida de whey (1 scoop) con hielo, leche de almendras sin azúcar y espinaca.'],
                        ['Cena', 'Carne molida extra magra (96/4, 4 oz) con sazón de taco, sobre un bowl grande de lechuga rallada, salsa y pepinillo en cubos.'],
                    ]),
                ],
            },
        ],
    };
})();
