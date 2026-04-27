@echo off
title Football Mutant - Serveur Multijoueur
cd /d "%~dp0"

echo.
echo  =============================================
echo   FOOTBALL MUTANT - Demarrage du serveur
echo  =============================================
echo.

:: Vérifier que Node.js est installé
node --version >nul 2>&1
if errorlevel 1 (
    echo  ERREUR : Node.js n'est pas installe.
    echo  Telechargez-le sur : https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Supprimer node_modules si installation corrompue (better-sqlite3)
if exist "node_modules\better-sqlite3" (
    echo  Nettoyage de l'ancienne installation...
    rmdir /s /q node_modules
)

:: Installer les dependances si node_modules absent
if not exist "node_modules\" (
    echo  Installation des dependances npm...
    echo.
    cmd /c npm install
    if errorlevel 1 (
        echo.
        echo  ERREUR : npm install a echoue.
        pause
        exit /b 1
    )
    echo.
    echo  Dependances installees !
    echo.
)

echo  Serveur accessible sur : http://localhost:3000
echo  Partagez votre IP locale avec vos amis sur le meme reseau.
echo.
echo  Appuyez sur Ctrl+C pour arreter le serveur.
echo.

node server.js

pause
