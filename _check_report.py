import asyncio
import httpx

async def main():
    async with httpx.AsyncClient() as client:
        r = await client.get("http://localhost:8000/api/verify/task-d77f34cd")
        print("task status:", r.status_code)
        print("task text len:", len(r.text))
        print(r.text[:500])
        print("---")
        r2 = await client.get("http://localhost:8000/api/verify/report/task-d77f34cd")
        print("report status:", r2.status_code)
        print("report text len:", len(r2.text))
        print(r2.text[:500])

asyncio.run(main())
