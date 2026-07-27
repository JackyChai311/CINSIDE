import asyncio
import os
from dotenv import load_dotenv
load_dotenv("backend/.env")

async def main():
    from browser_use.browser import BrowserProfile, BrowserSession
    profile = BrowserProfile(headless=False)
    session = BrowserSession(browser_profile=profile)
    try:
        await session.start()
        print("started")
        page = await session.navigate_to("http://localhost:8000/mock/index.html")
        print("navigate_to returned:", page)
        await asyncio.sleep(2)
        shot = await session.take_screenshot()
        print("screenshot len:", len(shot))
    except Exception as e:
        print("error:", e)
        import traceback
        traceback.print_exc()
    await session.close()

asyncio.run(main())
