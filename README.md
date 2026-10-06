<img width="2355" height="1267" alt="firefox_wiHIOnnNKL" src="https://github.com/user-attachments/assets/496ae8d1-5b14-4928-b0e2-c6a9efb1da05" />

This project was developed with assistance from AI tools.

# GikoMapHelper

A visual web-based editor for creating and editing room layouts in Gikopoi-like projects.

## Features

- **Visual room editor** See your room layout in real-time with a zoomable canvas

- **Grid alignment**  Snap the walkable grid to the map, with visual guides for tile coordinates

- **Object placement**  
Fit all objects — Auto-align each object's offset to its position in background.svg if it still exists in background.svg.
Drag and position interactive objects on your map, manually enter coordinates, can position objects that exist as seperate .svg files to where they also exist on the background map as well as remove them from the background.svg so they dont get rendered twice.

- **Wall/movement control**  Define blocked tiles and one-way walls
- **Sit and block points** Mark tiles where characters can sit or not move to at all

- **Automatic backups**  Every save backs up your original files to Desktop/GikoBackups

## Quick Start

**Requirements:** Node.js (LTS or newer)

1. Download the latest release
2. Extract the zip
3. Place files into the gikopoi folder
3. Run `GikoMapHelperGUI.bat`
4. A browser window opens with the editor, select a room and start editing
5. Press **Save** when you're done

## UI Guide

**Left panel:**
- Room selector
- Grid origin (X/Y coordinates)
- Object placement and editing
- Wall and movement controls
- Character preview (drag Giko around to check overlaps)
- Fit and crop tools

**Canvas:**
- Ctrl+scroll to zoom
- Click grid tiles to mark sit/blocked, if no giko is spawned in
- Click corners to snap grid alignment

