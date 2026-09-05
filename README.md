# StockNest — Inventory Management System

StockNest is a web-based inventory management system designed to manage products, stock, sales, depots, planning, and demand forecasting across multiple locations.

The system follows a modular architecture with separate frontend, backend, and machine-learning services. It provides role-based access, centralized inventory management, forecasting, and inventory decision support.

---

## 1. Project Overview

StockNest is designed for a supermarket or retail organization operating across multiple branches or depots.

The system allows authorized users to:

- Manage product/material information
- Manage depot and branch information
- Monitor inventory across locations
- Record and manage sales data
- Analyze historical sales trends
- Forecast future demand
- Calculate safety stock
- Generate inventory/replenishment decisions
- Import and manage master data through Excel files
- Access information according to their assigned role

The architecture is designed to support future expansion without tightly coupling the frontend, backend, database, and ML components.

---

## 2. Technology Stack

### Frontend
- React
- Vite
- Tailwind CSS
- Axios

### Backend
- Node.js
- Express.js
- MongoDB
- Mongoose
- JWT Authentication
- bcrypt Password Hashing

### Machine Learning Service
- Python
- Flask
- Forecasting and statistical/ML utilities
- Backtesting and model evaluation

### Development Tools
- Git
- GitHub
- VS Code
- npm
- Python virtual environment

---

## 3. System Architecture

```text
                    ┌──────────────────────┐
                    │      React UI        │
                    │   Vite + Tailwind    │
                    └──────────┬───────────┘
                               │
                               │ HTTP / REST API
                               ▼
                    ┌──────────────────────┐
                    │   Node.js + Express  │
                    │       Backend        │
                    └───────┬────────┬─────┘
                            │        │
                     MongoDB│        │HTTP
                            │        │
                            ▼        ▼
                    ┌───────────┐  ┌──────────────┐
                    │ MongoDB   │  │ ML Service   │
                    │ Database  │  │ Python       │
                    └───────────┘  └──────────────┘
```

The frontend communicates with the backend through REST APIs.

The backend handles authentication, authorization, business logic, database operations, inventory calculations, planning, and communication with the ML service.

The ML service handles forecasting and related model evaluation.

---

# 4. User Authentication and Authorization

StockNest uses JWT-based authentication.

Passwords are securely hashed using bcrypt before being stored.

The application currently supports two primary roles:

### ADMIN

Administrators have access to management functions including:

- Material Master
- Depot Master
- Stock Master
- Sales Master
- Planning Master
- Inventory and planning information

### USER

Regular users have access to operational dashboards and permitted inventory information according to their assigned role.

Role-based authorization is enforced on the backend rather than relying only on frontend navigation restrictions.

---

# 5. Application Modules

## 5.1 Dashboard

The dashboard provides a centralized overview of the inventory system.

Depending on the user's role, the dashboard displays relevant KPIs and navigation options.

Typical information includes:

- Inventory overview
- Stock status
- Sales information
- Demand/forecast information
- Planning information
- Inventory decision indicators

---

# 6. Master Data Management

StockNest uses multiple master modules to organize the information required by the inventory system.

## 6.1 Material Master

The Material Master contains the organization's product/material information.

Typical fields include:

- Material Number
- Description
- Model
- Standard/Discontinued Status
- Inventory Cost
- MOQ
- FG/RM Classification

### Features

- Add material
- Edit material
- View material records
- Search/filter materials
- Append data manually
- Import data from Excel
- Replace active imported data
- Maintain import history

Material Master access is restricted to authorized administrators.

---

## 6.2 Depot Master

Depot Master maintains information about branches, warehouses, or depots.

Typical fields include:

- Depot ID
- Depot Name

Depot information is used by other modules when managing location-specific inventory and planning data.

---

## 6.3 Stock Master

Stock Master contains inventory information for materials across different depots.

The module is designed around the organization's required stock data structure and supports location-level inventory analysis.

Stock information can be used by the planning and inventory decision components to determine the current inventory position and identify materials requiring attention.

### Features

- Search and filter stock records
- View stock by depot/material
- Import stock information
- Append imported data
- Replace active data
- Maintain import history

---

## 6.4 Sales Master

Sales Master stores historical sales information.

Sales data is an important input for:

- Demand analysis
- Sales trend analysis
- Forecast generation
- Planning calculations
- Inventory decision support

### Features

- View sales records
- Search/filter sales information
- Import sales data
- Append imported data
- Replace active data
- Maintain import history

---

# 7. Planning Master

Planning Master combines information from the major inventory modules to provide a consolidated planning view.

It uses financial years and quarterly sales information to analyze demand trends and support inventory planning.

### Planning Structure

Planning information is organized using:

- Financial Year
- Q1
- Q2
- Q3
- Q4
- Total

The module can use information from:

- Material Master
- Depot Master
- Stock Master
- Sales Master
- Forecasting services

### Planning Information

The planning view can include:

- Material Number
- Material Name
- Safety Stock
- Historical quarterly demand
- Current Stock
- Forecast-related information
- Inventory decision information

### User Interface

The Planning Master is designed as a read-oriented planning table.

Important usability features include:

- Material search
- Financial year selection
- Sticky left-side identification columns
- Sticky Current Stock column
- Multi-level table headers
- Financial year → quarterly structure
- Trend indicators for relevant values

The Planning Master does not expose unnecessary editing controls when the data is intended to be system-generated or read-only.

---

# 8. Inventory Decision Support

StockNest provides inventory decision support using current inventory information, historical demand, forecast demand, and safety stock.

The system can evaluate the relationship between:

```text
Current Stock
       +
Forecast Demand
       +
Safety Stock
       ↓
Inventory Decision
```

Possible decision categories can indicate situations such as:

- Replenishment required
- Stock sufficient
- Low stock
- Excess stock
- Other configured inventory conditions

The exact decision thresholds are determined by the backend inventory logic and configuration.

---

# 9. Demand Forecasting

StockNest includes a dedicated Python-based ML service for demand forecasting.

Historical sales data can be processed to estimate future demand.

The forecasting component is designed to support:

- Historical demand analysis
- Future demand forecasting
- Forecast target generation
- Model evaluation
- Backtesting
- Multi-step forecasting experiments

Forecast results can be consumed by the backend and presented through the StockNest planning interface.

---

# 10. Machine Learning Service

The ML service is maintained separately from the Node.js backend.

A simplified structure is:

```text
ml-service/
├── app/
│   ├── main.py
│   ├── config.py
│   ├── forecast.py
│   ├── backtest.py
│   └── multi_step_backtest.py
│
└── benchmark_training_windows.py
```

The ML service is responsible for forecasting-related processing and model evaluation.

Separating the ML service from the backend allows the forecasting component to evolve independently from the main application.

---

# 11. Data Import System

StockNest supports Excel-based data management for applicable master modules.

The import system is designed around an active dataset concept.

### Import Options

#### Append

Adds the imported records to the currently active dataset.

#### Replace

Replaces the active dataset with the newly imported dataset.

### Import History

Import history allows users to manage previously imported files.

Supported operations include:

- View/select an imported dataset
- Make a dataset active
- Append data
- Delete an imported dataset

This provides a controlled way of managing changing inventory and sales datasets.

---

# 12. Database

StockNest uses MongoDB as its primary application database.

Mongoose is used in the backend to define schemas and interact with MongoDB.

The database stores application information such as:

- Users
- Materials
- Depots
- Stock
- Sales
- Planning-related information
- Imported data and related metadata

Sensitive configuration such as the MongoDB connection string is stored using environment variables.

---

# 13. Backend Structure

A simplified backend structure is:

```text
backend/
├── models/
├── routes/
├── controllers/
├── services/
├── middleware/
├── utils/
├── server.js
└── package.json
```

Important backend responsibilities include:

- Authentication
- Authorization
- REST API endpoints
- Database operations
- Master-data management
- Planning logic
- Forecast integration
- Inventory decision logic
- Data import processing

---

# 14. Frontend Structure

A simplified frontend structure is:

```text
frontend/
├── src/
│   ├── components/
│   ├── pages/
│   ├── services/
│   ├── assets/
│   └── ...
├── package.json
└── vite.config.*
```

The frontend is responsible for:

- User interface
- Navigation
- Role-based presentation
- Tables and dashboards
- Search/filter controls
- API communication
- Planning visualization
- Forecast visualization

---

# 15. Environment Variables

Environment-specific configuration should not be committed to Git.

Examples include:

```text
MONGO_URI
JWT_SECRET
ML_SERVICE_URL
PORT
```

Actual `.env` files are intentionally excluded from version control.

A developer setting up the project locally should create the required environment files using the appropriate values for their environment.

---

# 16. Running the Project

StockNest consists of multiple services that should be started separately during development.

### Backend

```bash
cd backend
npm install
npm run dev
```

The backend is configured to run on the project's configured backend port.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend is served by Vite during development.

### ML Service

Create/activate the Python virtual environment and install the required Python dependencies.

Then start the ML application using the project's configured Python entry point.

The exact ML-service port should match the value configured in the backend.

---

# 17. Git and GitHub

The project is maintained using Git.

The GitHub repository is:

**StockNest**

Repository:

```text
https://github.com/aravvindd7/StockNest
```

Important files and folders that should not normally be committed include:

```text
node_modules/
dist/
build/
.env
.env.*
coverage/
*.log
.DS_Store
```

These are excluded through `.gitignore`.

---

# 18. Development Workflow

A typical development workflow is:

```text
1. Start Mongo