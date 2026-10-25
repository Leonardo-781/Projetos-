#include <Arduino.h>

const int PINO_LAMPADA = 10;
const int PINO_COOLER  = 7;
const int PINO_LED     = 6;

void acionar(int pino, bool ligar) {
  if (ligar) {
    pinMode(pino, OUTPUT);
    digitalWrite(pino, LOW);  // Puxa para 0V -> LIGA
  } else {
    pinMode(pino, INPUT);     // Alta impedancia -> DESLIGA (corta fuga de 5V)
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=============================================="));
  Serial.println(F(" TESTE HI-Z / CORTE TOTAL DE FUGA 5V (PINOS 10, 6, 7)"));
  Serial.println(F("=============================================="));
  // Inicia todos desligados
  acionar(PINO_LAMPADA, false);
  acionar(PINO_COOLER, false);
  acionar(PINO_LED, false);
}

void loop() {
  // 1. Testa LÂMPADA (Pino 10)
  Serial.println(F("--> [TESTE 1] LAMPADA (Pino 10): LIGANDO por 3s..."));
  acionar(PINO_LAMPADA, true);
  delay(3000);

  Serial.println(F("--> [TESTE 1] LAMPADA (Pino 10): DESLIGANDO por 3s..."));
  acionar(PINO_LAMPADA, false);
  delay(3000);

  // 2. Testa COOLER (Pino 6)
  Serial.println(F("--> [TESTE 2] COOLER (Pino 6): LIGANDO por 3s..."));
  acionar(PINO_COOLER, true);
  delay(3000);

  Serial.println(F("--> [TESTE 2] COOLER (Pino 6): DESLIGANDO por 3s..."));
  acionar(PINO_COOLER, false);
  delay(3000);

  // 3. Testa LED (Pino 7)
  Serial.println(F("--> [TESTE 3] LED (Pino 7): LIGANDO por 3s..."));
  acionar(PINO_LED, true);
  delay(3000);

  Serial.println(F("--> [TESTE 3] LED (Pino 7): DESLIGANDO por 3s..."));
  acionar(PINO_LED, false);
  delay(3000);
}
