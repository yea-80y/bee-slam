# Contributing to Bee SLAM

Thank you for considering contributing to Bee SLAM! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/bee-slam.git
   cd bee-slam
   ```
3. Set up your development environment (see below)

## Development Setup

### Prerequisites

- Docker and Docker Compose
- pnpm (for proxy development)
- Node.js 22+ (if developing proxy locally)

### Initial Setup

```bash
# Set up environment
cp .env.example .env
# Edit .env and set BEE_PASSWORD

# Start services
docker compose up -d

# For proxy development
cd proxy
pnpm install
pnpm dev  # Hot reload development mode
```

## Making Changes

### Branch Naming

- Feature branches: `feature/description`
- Bug fixes: `fix/description`
- Documentation: `docs/description`

Example: `feature/add-rate-limiting`

### Code Style

#### TypeScript (Proxy)

- Use strict TypeScript mode (already configured in `tsconfig.json`)
- Prefix unused parameters with underscore: `_req`, `_res`
- Follow existing patterns in `src/index.ts` and `src/whitelist.ts`
- Run `pnpm build` to check for type errors before committing

#### Docker

- Keep `docker-compose.yml` clean and well-commented
- Multi-stage builds for production images
- Use explicit version tags, not `latest`

### Testing Changes

```bash
# Test proxy functionality
cd proxy

# Build TypeScript
pnpm build

# Test ENS resolution
pnpm test:ens

# Rebuild and test with Docker
cd ..
docker compose build proxy
docker compose up -d proxy
docker logs -f bee-proxy
```

### Documentation

- Update README.md for user-facing changes
- Update CLAUDE.md for architectural changes
- Update SIMPLE_ARCHITECTURE.md for high-level design changes
- Add inline code comments for complex logic

## Submitting Changes

### Commit Messages

Follow the conventional commit format:

```
<type>: <description>

[optional body]

[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test changes
- `chore`: Build/tooling changes

Example:
```
feat: add rate limiting to proxy endpoints

Implements per-IP rate limiting using express-rate-limit
to prevent abuse of the admin API.

Closes #42
```

### Pull Request Process

1. **Update documentation** if needed
2. **Test your changes** thoroughly:
   - Docker compose still builds and runs
   - Proxy functionality works (whitelist, content access)
   - No TypeScript errors (`pnpm build` in proxy/)
3. **Create a pull request** with:
   - Clear title describing the change
   - Description of what changed and why
   - Reference any related issues
4. **Respond to review feedback** promptly

### Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Docker compose builds successfully
- [ ] Proxy starts without errors
- [ ] Whitelist functionality works
- [ ] ENS test passes (if relevant)
- [ ] Manual testing completed

## Checklist
- [ ] Code follows project style
- [ ] Documentation updated
- [ ] No TypeScript errors
- [ ] Commits follow conventional format
```

## Areas for Contribution

### Good First Issues

- Add more comprehensive error handling
- Improve logging output
- Add health check endpoints for monitoring
- Enhance ENS test script with more examples

### Feature Ideas

- **Authentication**: Add API key authentication for admin endpoints
- **Rate Limiting**: Implement per-IP rate limiting
- **Metrics**: Add Prometheus metrics export
- **Caching**: Add caching layer for frequently accessed hashes
- **Database**: Replace JSON file with proper database (SQLite/PostgreSQL)
- **UI**: Create admin web interface for whitelist management
- **CLI**: Create command-line tool for whitelist management

### Documentation

- Add more detailed examples
- Create video tutorials
- Translate documentation
- Add troubleshooting guides

## Code Review Process

Maintainers will review your pull request and may:
- Request changes
- Suggest improvements
- Merge if everything looks good

Please be patient - maintainers may be busy. Expect feedback within a few days.

## Community Guidelines

- Be respectful and constructive
- Help others in discussions
- Report security issues privately (see SECURITY.md when available)
- Follow the [Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the BSD 3-Clause License.
