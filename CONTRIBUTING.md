# Contributing to Code2Larp

Thank you for your interest in contributing to **Code2Larp**! This project was created for the NASA Space Apps Challenge to bring space science and live-action simulation together.

## 🚀 How to Contribute

### 1. Finding or Creating an Issue
- Check existing issues before creating a new one.
- For new features, simulations, or NASA dataset integrations, open an issue using the appropriate template.

### 2. Development Workflow
1. Fork the repository and create your branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Verify your changes locally:
   ```bash
   npm run dev
   npm run build
   ```
4. Commit your changes using descriptive commit messages:
   ```bash
   git commit -m "feat(telemetry): add solar radiation sensor gauge"
   ```
5. Push to your branch and open a Pull Request against `main`.

## 🛰️ Coding Guidelines
- **TypeScript:** Write typed code. Avoid using `any` where interfaces or union types can be declared.
- **Components:** Modularize React components into single-responsibility units inside `src/components/`.
- **NASA Data:** When integrating new NASA endpoints, provide safe fallbacks so offline users or users without private API keys can still run simulations with demo datasets.
- **Styling:** Use Tailwind utility classes following our dark sci-fi HUD theme.

## 💬 Community & Questions
Reach out by opening a GitHub Discussion or Issue in this repository.
