public final class addTest {
    public static void main(String[] args) {
        if (Calculator.add(2, 3) != 5) throw new AssertionError("add");
        System.out.println("add passed");
    }
}
