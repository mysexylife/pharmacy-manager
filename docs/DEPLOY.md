# Fly.io(도쿄)에 올리기

SQLite 파일 하나를 쓰는 앱이라 **기계(머신)는 반드시 1대만** 둡니다. 아래 순서는 모두 약국 PC에서 한 번만 하면 됩니다.

## 1. 준비
1. https://fly.io 에서 가입하고 결제 수단을 등록합니다 (본인이 직접).
2. `flyctl` 설치 (Windows PowerShell):
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
3. 로그인:
   ```bash
   fly auth login
   ```

## 2. 앱 만들기
저장소 폴더에서 (이름은 영문 소문자·숫자·`-`, 세계에서 하나뿐이어야 함):
```bash
fly launch --no-deploy --copy-config --name 내가정한이름 --region nrt
```
`fly.toml`의 `app` 값이 바뀝니다. (메모장 등으로 직접 고칠 때는 **UTF-8 BOM 없이** 저장하세요. PowerShell의 `Set-Content -Encoding utf8`은 BOM이 붙어 fly가 읽지 못합니다.) 질문이 나오면 데이터베이스(Postgres/Redis)는 **만들지 않습니다**.

## 3. 저장소(볼륨) 만들기 — 반드시 1개
```bash
fly volumes create pharmacy_data --region nrt --size 1
```

## 4. 배포
```bash
fly deploy --ha=false
```
끝나면 `https://내가정한이름.fly.dev` 로 접속됩니다. 처음 접속하면 "약사 계정 만들기" 화면이 나옵니다. **길고 안전한 비밀번호**(10자 이상)를 정하세요.

## 5. 엑셀 가져오기
로그인 → 설정 → "엑셀에서 가져오기"에서 제약회사 장부와 외상 장부 `.xlsx`를 함께 올리고, 미리보기를 확인한 뒤 가져옵니다. 환자 정보는 GitHub에 올라가지 않고 이 서버의 볼륨에만 저장됩니다.

## 6. 폰에서 쓰기
폰 브라우저로 같은 주소에 접속해 로그인하고 "이 기기에서 로그인 유지"를 체크합니다. 홈 화면에 추가해 두면 편합니다.

## 백업
- 설정 → "백업 파일 받기"로 DB 전체를 내려받을 수 있습니다. **매주/매월 한 번** 받아 약국 PC 등 안전한 곳에 두세요.
- Fly 볼륨은 자동 스냅샷이 있지만 보관 기간이 짧으므로 위 백업을 대신하지 못합니다.
  ```bash
  fly volumes snapshots list
  ```

## 자동 배포 (GitHub Actions)
`claude/epic-ride-xkr14e` 브랜치에 코드가 올라오면 `.github/workflows/fly-deploy.yml`이 자동으로 시험(`npm test`)을 돌리고, 통과하면 서버에 배포합니다.
필요한 설정은 GitHub 저장소 Settings > Secrets and variables > Actions 의 `FLY_API_TOKEN` 하나입니다 (`fly tokens create deploy -a 앱이름`으로 만든 토큰).
실행 결과는 저장소의 Actions 탭에서 볼 수 있습니다.

## 업데이트 (직접 배포할 때)
코드가 바뀌면 같은 폴더에서 `fly deploy --ha=false` 만 다시 하면 됩니다. 데이터는 볼륨에 그대로 남습니다.

## 문제가 생기면
```bash
fly logs          # 서버 로그
fly status        # 머신 상태 (1대만 있어야 함)
fly ssh console   # 서버 안으로 들어가기
```
- 접속이 처음에 몇 초 느리면 잠들어 있던 머신이 깨어나는 것입니다. 싫으면 `fly.toml`의 `min_machines_running`을 `1`로 바꾸세요 (비용이 조금 늘어남).
- 비용은 사용량에 따라 다르니 Fly 대시보드의 Billing에서 확인하세요.
